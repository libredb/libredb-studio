/**
 * The S3 editor text, read as words: one AWS CLI read command, or Studio's own preview.
 *
 * Pure, and shipped to the browser. The words are the shared shell-word reader's
 * (`src/lib/db/console/shell-words.ts`): its quoting, its refusals and its one-command rule. This module adds what
 * is S3's: a scan for the Windows `^` continuation before the reader runs, the prompt and the optional `aws` a
 * pasted line carries, the refusal of a leading environment assignment, the option-word rule, where the service and
 * the operation stand, and the role each token takes in the editor. The lead-stripping layer repeats Oxia's
 * (`src/lib/db/providers/keyvalue/oxia/lexer.ts`) with S3's lead words, because a provider may not import another
 * provider's module; the consolidation is a backlog entry.
 *
 * The line-by-line reading names the lead, the service and the operation only on the line the command begins on,
 * and only up to the shared tokenizer's eighth word: the per-line state does not hold earlier words' text. The
 * parser reads the whole text and is not limited that way.
 */
import {
  INITIAL_SHELL_LINE_STATE,
  readShellCommand,
  type ShellLineState,
  type ShellRefusal,
  type ShellToken,
  type ShellWord,
  tokenizeShellLine,
} from "@/lib/db/console/shell-words";

export type S3TokenRole =
  | "lead"
  | "service"
  | "operation"
  | "flag"
  | "path"
  | "word"
  | "string"
  | "comment"
  | "whitespace"
  | "invalid";

export interface S3Token {
  readonly role: S3TokenRole;
  readonly start: number;
  readonly end: number;
}

/** The shared reader's initial state: the S3 lexer keeps no state of its own. */
export const INITIAL_S3_LEX_STATE: ShellLineState = INITIAL_SHELL_LINE_STATE;

/** The prompts a documented command line is printed after. */
export const S3_PROMPTS: ReadonlySet<string> = new Set(["$", "%"]);

/**
 * The AWS CLI's global options that take a value. Written as `--name value`, each takes the next word, which is
 * therefore neither the service nor the operation; written as `--name=value`, it takes none. The parser reads the
 * same set, so the editor never draws another service or operation than the one that runs.
 */
export const S3_VALUE_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "--endpoint-url",
  "--output",
  "--query",
  "--profile",
  "--region",
  "--color",
  "--ca-bundle",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--cli-binary-format",
  "--cli-error-format",
]);

export const S3_CARET_SENTENCE =
  "A ^ continues a line only in Windows cmd, which Studio does not read: join the lines, or end each one with a backslash.";

export const S3_ASSIGNMENT_SENTENCE =
  "The command begins with an environment assignment, which Studio does not read: the Access key and Secret on the connection sign every request. Remove the assignment.";

/** A refusal of this module's own, in the shape of the shared reader's. */
export interface S3LexRefusal {
  readonly code: "caret" | "assignment";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

const LEAD_COMMAND = "aws";
const PATH_SCHEME = "s3://";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);
const isBlank = (char: string): boolean => char === " " || char === "\t";
const isLineEnd = (char: string): boolean => char === "\n" || char === "\r";

/**
 * The first unquoted word that is exactly `^`, with its 1-based line and 0-based column, read with the shared
 * reader's quoting rules: single quotes keep everything, double quotes keep everything but the four escapes, a
 * backslash outside single quotes escapes the next character (a backslash-newline joins two lines), and `#` at a
 * word's start outside quotes runs to the line's end. It runs before the shared reader, which would otherwise report
 * the second line of a Windows paste as a second command and never name the cause.
 */
export function caretContinuationAt(text: string): { readonly line: number; readonly column: number } | undefined {
  let quote: "none" | "single" | "double" = "none";
  let inWord = false;
  let line = 1;
  let column = 0;
  for (let at = 0; at < text.length; at++, column++) {
    const char = text.charAt(at);
    if (isLineEnd(char)) {
      if (char === "\r" && text.charAt(at + 1) === "\n") at++;
      line++;
      column = -1;
      if (quote === "none") inWord = false;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = "none";
      continue;
    }
    if (quote === "double") {
      if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(text.charAt(at + 1))) {
        at++;
        column++;
      } else if (char === '"') quote = "none";
      continue;
    }
    if (char === "\\") {
      const next = text.charAt(at + 1);
      if (isLineEnd(next)) {
        // A backslash-newline joins the two lines: the word, if one was open, runs on.
        at += next === "\r" && text.charAt(at + 2) === "\n" ? 2 : 1;
        line++;
        column = -1;
        continue;
      }
      if (next !== "") {
        at++;
        column++;
      }
      inWord = true;
      continue;
    }
    if (isBlank(char)) {
      inWord = false;
      continue;
    }
    if (!inWord && char === "#") {
      while (at + 1 < text.length && !isLineEnd(text.charAt(at + 1))) {
        at++;
        column++;
      }
      continue;
    }
    if (!inWord && char === "^") {
      const next = text.charAt(at + 1);
      if (next === "" || isBlank(next) || isLineEnd(next)) return { line, column };
    }
    if (char === "'") quote = "single";
    else if (char === '"') quote = "double";
    inWord = true;
  }
  return undefined;
}

/** The physical lines of the last text read, split as the shared reader splits them: at CRLF, CR or LF. */
let cachedLines: { readonly text: string; readonly lines: readonly string[] } | undefined;
function linesOf(text: string): readonly string[] {
  if (cachedLines === undefined || cachedLines.text !== text) cachedLines = { text, lines: text.split(/\r\n|\r|\n/) };
  return cachedLines.lines;
}

/** Whether the word's first `length` characters stand in the source as written, unquoted and unescaped. */
function plainPrefix(word: ShellWord, text: string, length: number): boolean {
  const line = linesOf(text)[word.line - 1] ?? "";
  return line.slice(word.column, word.column + length) === word.text.slice(0, length);
}

/**
 * An option word: its text begins with `-`, is longer than `-` alone, and the source characters that spell its
 * leading `-` and its name, up to and including the first `=`, are unquoted. So `--prefix='-x y'` is the option
 * `--prefix` with the value `-x y`, while `'--prefix'`, `"-x"` and `\--key` are values.
 */
export function isOptionWord(word: ShellWord, text: string): boolean {
  if (word.text.length < 2 || !word.text.startsWith("-")) return false;
  const equals = word.text.indexOf("=");
  return plainPrefix(word, text, equals < 0 ? word.text.length : equals + 1);
}

/** `NAME=` with the name and the = unquoted, whatever the value's quoting. */
function isAssignmentWord(word: ShellWord, text: string): boolean {
  return ASSIGNMENT.test(word.text) && plainPrefix(word, text, word.text.indexOf("=") + 1);
}

/**
 * The command line's words with the lead stripped: one prompt, then `aws`. The `^` scan runs first, then the shared
 * reader, then the assignment refusal, which quotes nothing of the assignment.
 */
export function s3Words(
  text: string,
):
  | { readonly ok: true; readonly lead: readonly ShellWord[]; readonly words: readonly ShellWord[] }
  | { readonly ok: false; readonly refusal: ShellRefusal | S3LexRefusal } {
  const caret = caretContinuationAt(text);
  if (caret !== undefined) return { ok: false, refusal: { code: "caret", message: S3_CARET_SENTENCE, ...caret } };
  const reading = readShellCommand(text);
  if (!reading.ok) return reading;
  const all = reading.words;
  let at = 0;
  if (at < all.length && !all[at].quoted && S3_PROMPTS.has(all[at].text)) at += 1;
  if (at < all.length && isAssignmentWord(all[at], text)) {
    const word = all[at];
    return {
      ok: false,
      refusal: { code: "assignment", message: S3_ASSIGNMENT_SENTENCE, line: word.line, column: word.column },
    };
  }
  if (at < all.length && !all[at].quoted && all[at].text === LEAD_COMMAND) at += 1;
  return { ok: true, lead: all.slice(0, at), words: all.slice(at) };
}

/**
 * Where the service and the operation stand among the words after the lead: the service is the first word that is
 * neither an option word nor the value of a value-taking global written without `=`; after `s3` or `s3api`, the
 * next such word is the operation. The parser and completion both read through it.
 */
export function s3CommandShape(
  words: readonly ShellWord[],
  text: string,
): { readonly serviceAt?: number; readonly operationAt?: number } {
  const plainFrom = (from: number): number | undefined => {
    for (let at = from; at < words.length; at++) {
      const word = words[at];
      if (!isOptionWord(word, text)) return at;
      if (S3_VALUE_GLOBAL_OPTIONS.has(word.text)) at += 1;
    }
    return undefined;
  };
  const serviceAt = plainFrom(0);
  if (serviceAt === undefined) return {};
  const service = words[serviceAt].text;
  if (service !== "s3" && service !== "s3api") return { serviceAt };
  const operationAt = plainFrom(serviceAt + 1);
  return operationAt === undefined ? { serviceAt } : { serviceAt, operationAt };
}

/** One word of a line, as its tokens draw it. */
interface LineWord {
  readonly index: number;
  readonly tokens: ShellToken[];
}

/** The line's words that carry an index, in order, each with its tokens. */
function indexedWords(tokens: readonly ShellToken[]): LineWord[] {
  const words: LineWord[] = [];
  for (const token of tokens) {
    if (token.wordIndex === undefined) continue;
    const last = words[words.length - 1];
    if (last !== undefined && last.index === token.wordIndex) last.tokens.push(token);
    else words.push({ index: token.wordIndex, tokens: [token] });
  }
  return words;
}

/** A word's text when all of it is one unquoted, unescaped token; undefined otherwise. */
function plainText(line: string, word: LineWord): string | undefined {
  if (word.tokens.length !== 1) return undefined;
  const [token] = word.tokens;
  if (token.kind !== "word" && token.kind !== "flag") return undefined;
  const text = line.slice(token.start, token.end);
  return text.includes("\\") ? undefined : text;
}

/** Which of the line's words are lead words, the service and the operation, by word index. */
function leadServiceOperation(
  line: string,
  words: readonly LineWord[],
  openIndex: number | undefined,
): ReadonlyMap<number, "lead" | "service" | "operation"> {
  const roles = new Map<number, "lead" | "service" | "operation">();
  let at = 0;
  const plain = (): string | undefined =>
    at < words.length && words[at].index !== openIndex ? plainText(line, words[at]) : undefined;
  const prompt = plain();
  if (prompt !== undefined && S3_PROMPTS.has(prompt)) {
    roles.set(words[at].index, "lead");
    at += 1;
  }
  if (plain() === LEAD_COMMAND) {
    roles.set(words[at].index, "lead");
    at += 1;
  }
  let valueNext = false;
  let service: string | undefined;
  for (; at < words.length; at++) {
    const word = words[at];
    // A word that runs on past this line is not read whole here, so it decides nothing.
    if (word.index === openIndex) break;
    if (valueNext) {
      valueNext = false;
    } else if (word.tokens[0].kind === "flag") {
      valueNext = S3_VALUE_GLOBAL_OPTIONS.has(plainText(line, word) ?? "");
    } else if (service === undefined) {
      roles.set(word.index, "service");
      service = plainText(line, word) ?? "";
      if (service !== "s3" && service !== "s3api") break;
    } else {
      roles.set(word.index, "operation");
      break;
    }
  }
  return roles;
}

/** One physical line as the editor draws it, from the state the line before left. */
export function tokenizeS3Line(
  line: string,
  state: ShellLineState,
): { readonly tokens: readonly S3Token[]; readonly state: ShellLineState } {
  const reading = tokenizeShellLine(line, state);
  const begins = state.section !== "after" && state.wordsBefore === 0 && !state.inWord;
  const words = begins ? indexedWords(reading.tokens) : [];
  const openIndex = reading.state.inWord ? reading.state.wordsBefore : undefined;
  const roles = leadServiceOperation(line, words, openIndex);
  const tokens = reading.tokens.map((token): S3Token => {
    const role = token.wordIndex === undefined ? undefined : roles.get(token.wordIndex);
    if (role === "lead") return { role: "lead", start: token.start, end: token.end };
    if (role !== undefined && token.kind === "word") return { role, start: token.start, end: token.end };
    if (token.kind === "word" && line.startsWith(PATH_SCHEME, token.start))
      return { role: "path", start: token.start, end: token.end };
    return { role: token.kind, start: token.start, end: token.end };
  });
  return { tokens, state: reading.state };
}
