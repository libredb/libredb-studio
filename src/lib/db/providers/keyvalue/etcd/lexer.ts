/**
 * The etcd editor text, read as words (spec 3.1, 3.3, 5.1.1, 5.1.2, 5.1.4, 6.4).
 *
 * Pure, and shipped to the browser: the command parser, the confirmation gate and the editor's
 * tokens provider all read the text through this module, so a word the editor draws as one word
 * is the word the provider runs, holding the same bytes (R11 ARCH-9). It imports nothing.
 *
 * Two word rules, one for each place in the text:
 *
 * - The command line, the first logical line, is read by the POSIX shell's quoting rules, because
 *   an etcdctl command is written for a shell. Studio runs no shell, so text a shell would expand
 *   or reject is refused here rather than taken literally, which would store a different value
 *   from the one the user meant. What a shell does was measured against bash 5.2.21, dash and
 *   zsh 5.9 before it was written down: a `$` before anything but a blank, the end of the word or
 *   a closing double quote (bash reads `$'..'`, `$".."` and `$[..]`, zsh `$=x` and `$~x`), a
 *   backquote, a `~` that begins a word or follows the `=` or a `:` of an unquoted `NAME=` word
 *   (bash outside POSIX mode), an unquoted `=` that begins a word holding more than it (zsh puts
 *   the path of the command the rest names in its place, or fails), braces holding an unquoted
 *   comma or a `..` quoted or not (bash and zsh expand them into several words, zsh even
 *   `{1.'.'3}`), a backslash that ends the text (bash keeps it and zsh drops it), and `;`, `&`,
 *   `|`, `<`, `>`, `(` and `)`. Glob characters stay data, as a shell passes them when nothing
 *   matches.
 * - A txn body is read as etcdctl v3.7.2 reads its standard input (txn_command.go): each line
 *   trimmed as Go's strings.TrimSpace trims it, a compare split as ParseCompare's
 *   fmt.Sscanf("%q) %s %q") reads it, a request split by Argify's regular expression (util.go),
 *   and a Go quoted string decoded as strconv.Unquote decodes it, so `\xNN` and an octal escape
 *   are single bytes. Where Argify would change a word in silence (a quoted word followed
 *   directly by other text, a quote left open) the line is refused instead.
 *
 * `tokenizeLine` reads one physical line from a state, which is what the tokens provider calls;
 * `splitWords` applies the same reading to every line of a text in turn, which is what the parser
 * calls, so the two cannot disagree (spec 3.3). The state is bounded whatever the text holds: of the
 * command line's words it keeps only how far they go among the leading tokens, and of a word still
 * open only what those read, so the editor keeps one small state per line; `splitWords` joins the
 * words' text itself, as it reads. Lines end at CRLF, CR or LF, as the editor's model ends them.
 *
 * `ETCD_SCHEMA_REFRESH_PATTERN`, the regular expression the provider declares to reload the tree
 * after a write, restates the command line's rules, so it is built at the end of this module, beside
 * them, and its tests hold it to the parser (spec 3.5, 6.2).
 */

// ============================================================================
// The state and the tokens (spec 3.3)
// ============================================================================

export type LexQuote = "none" | "single" | "double";

/**
 * The part of the text a line is read in: "command" up to and including the command line (the
 * blank and comment lines before it too); a txn body's three lists; "after-body" past a txn's
 * failure list, where only empty and `#` lines may follow; and "after-command" past any other
 * command, where only blank and comment lines may follow (spec 5.1.2, 5.1.4).
 */
export type LexSection = "command" | "compares" | "success" | "failure" | "after-body" | "after-command";

/**
 * How far a command line's words go among the leading tokens of spec 5.1.2, which decide its command
 * word, named by the first role the next word may take: "prompt" for the first word, "env" after a
 * prompt, "assignment" after env or an assignment (the etcdctl word may come there too), "flag" after
 * the etcdctl word or a flag, and "flag-value" after --command-timeout; or, once the command word is
 * read, whether it is "txn" or any other "command".
 */
export type LexLead = "prompt" | "env" | "assignment" | "flag" | "flag-value" | "txn" | "command";

/**
 * What the leading tokens read of a command-line word still open at the end of a line: its start, its
 * end, and whether it begins NAME=. It is bounded whatever the word's length, so a word that runs over
 * many lines leaves a state of the same size behind each of them.
 */
export interface LexLeadWord {
  /** The word's first units, at most 18: one more than --command-timeout, the longest word the leading tokens name. */
  readonly head: string;
  /** One mark per unit of `head`: "u" unquoted, "q" quoted or escaped. */
  readonly quoting: string;
  /** The word's longest end that /etcdctl begins with, which a path to etcdctl ends in. */
  readonly tail: string;
  /**
   * Whether the word begins NAME=, an assignment: "start" before its first unit, "name" while each unit
   * so far is an unquoted name character, then "yes" at an unquoted = or "no" at anything else.
   */
  readonly assignment: "start" | "name" | "yes" | "no";
}

export interface LexState {
  readonly section: LexSection;
  /** Command line only: a quote left open at the end of the line just read. */
  readonly quote: LexQuote;
  /** Command line only: the line just read ended with a backslash-newline outside single quotes. */
  readonly continued: boolean;
  /** Command line only: a word runs on past the end of the line just read. */
  readonly inWord: boolean;
  /** Command line only: how far its words go among the leading tokens, which decides the next section. */
  readonly lead: LexLead;
  /** Command line only: what the leading tokens read of the word still open, while they still read words. */
  readonly leadWord?: LexLeadWord;
}

export const INITIAL_LEX_STATE: LexState = {
  section: "command",
  quote: "none",
  continued: false,
  inWord: false,
  lead: "prompt",
};

export type LexTokenKind = "word" | "flag" | "string" | "comment" | "operator" | "whitespace" | "invalid";

/** A span of one physical line; `start` and `end` are offsets in that line (spec 3.3). */
export interface LexToken {
  readonly kind: LexTokenKind;
  readonly start: number;
  readonly end: number;
}

/** Whether two states are the same, for the tokens provider's state object. */
export function lexStatesEqual(a: LexState, b: LexState): boolean {
  if (a.section !== b.section || a.quote !== b.quote || a.continued !== b.continued) return false;
  if (a.inWord !== b.inWord || a.lead !== b.lead) return false;
  if (a.leadWord === undefined || b.leadWord === undefined) return a.leadWord === b.leadWord;
  const x = a.leadWord;
  const y = b.leadWord;
  return x.head === y.head && x.quoting === y.quoting && x.tail === y.tail && x.assignment === y.assignment;
}

// ============================================================================
// Words, refusals and the whole text read
// ============================================================================

/** A word as a command reads it. `text` holds the bytes as UTF-8, a U+FFFD where they are not. */
export interface Word {
  readonly text: string;
  readonly bytes: Uint8Array;
  /** 1-based line and 0-based column of the word's first source character. */
  readonly line: number;
  readonly column: number;
  /** 1-based line and 0-based exclusive column just past its last source character. */
  readonly endLine: number;
  readonly endColumn: number;
}

export type LexRefusalCode =
  | "unclosed-quote"
  | "trailing-backslash"
  | "shell-expansion"
  | "shell-operator"
  | "not-text"
  | "txn-quoting"
  | "txn-syntax";

export interface LexRefusal {
  readonly code: LexRefusalCode;
  /** The whole sentence the user reads. It names a place in the text and never quotes a value. */
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** A txn compare's parts as ParseCompare reads them (spec 5.1.4). */
export interface TxnCompareWords {
  readonly target: Word;
  readonly key: Word;
  readonly operator: Word;
  readonly value: Word;
  /** Text after the value's closing quote, which etcdctl ignores and the parser refuses. */
  readonly rest: string;
}

export type LexLineRole = "blank" | "comment" | "command" | "compare" | "request" | "content";

export interface SplitLine {
  readonly line: number;
  /** The physical line as written. */
  readonly text: string;
  /** The column where the line's first token that is not whitespace starts; the line's length for a blank line. */
  readonly start: number;
  /** The section the line is read in. */
  readonly section: LexSection;
  readonly role: LexLineRole;
  /** A compare line that reads. */
  readonly compare?: TxnCompareWords;
  /** A request line that reads. */
  readonly words?: readonly Word[];
  /** A compare or request line that does not read. */
  readonly refusal?: LexRefusal;
}

/** Where the command word stands among the leading tokens of spec 5.1.2. */
export type LeadRole = "prompt" | "env" | "assignment" | "etcdctl" | "flag" | "flag-value";

export interface LeadingTokens {
  /** One role per word before the command word. */
  readonly roles: readonly LeadRole[];
  /** The command word's index among the command line's words; their count when there is none. */
  readonly commandIndex: number;
}

export interface SplitText {
  readonly lines: readonly SplitLine[];
  /** The command line's words: the first logical line that is not blank or a comment. */
  readonly command: readonly Word[];
  readonly lead: LeadingTokens;
}

export type SplitResult =
  | { readonly ok: true; readonly split: SplitText }
  | { readonly ok: false; readonly refusal: LexRefusal };

// ============================================================================
// Characters
// ============================================================================

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF: without it the decoder drops it and the text is not the bytes.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function decodeStrict(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";

/** Go's unicode.IsSpace, which strings.TrimSpace and fmt's scanner both use. */
function isGoSpace(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** RE2's \s, which Argify's regular expression splits on: no vertical tab and nothing past ASCII. */
const isArgifySpace = (char: string): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\f" || char === "\r";

const SHELL_OPERATORS: ReadonlySet<string> = new Set([";", "&", "|", "<", ">", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);

/**
 * A shell name, as POSIX writes one: a letter or _, then letters, digits and _. It is declared once, for
 * the two readers of a NAME= word: the ~ rule reads the word whole, and the leading tokens read an
 * assignment one unit at a time, since a word they read may run over many lines (spec 5.1.1, 5.1.2).
 */
const NAME_FIRST_CLASS = "[A-Za-z_]";
const NAME_REST_CLASS = "[A-Za-z0-9_]";
const NAME_ASSIGNMENT = new RegExp(`^${NAME_FIRST_CLASS}${NAME_REST_CLASS}*=`);
const NAME_FIRST = new RegExp(`^${NAME_FIRST_CLASS}$`);
const NAME_REST = new RegExp(`^${NAME_REST_CLASS}$`);

/** The first unpaired UTF-16 surrogate's offset, or -1. */
function loneSurrogateAt(text: string): number {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else return index;
    } else if (code >= 0xdc00 && code <= 0xdfff) return index;
  }
  return -1;
}

interface PhysicalLine {
  readonly text: string;
  /** Offset of the line's first character in the whole text. */
  readonly start: number;
  /** Offset just past the line's break, or the text's length for the last line. */
  readonly next: number;
}

function physicalLines(text: string, from: number): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  const breaks = /\r\n|\r|\n/g;
  breaks.lastIndex = from;
  let start = from;
  for (let found = breaks.exec(text); found !== null; found = breaks.exec(text)) {
    lines.push({ text: text.slice(start, found.index), start, next: found.index + found[0].length });
    start = found.index + found[0].length;
  }
  lines.push({ text: text.slice(start), start, next: text.length });
  return lines;
}

/** 1-based line and 0-based column of an offset. */
function positionOf(text: string, offset: number): { readonly line: number; readonly column: number } {
  const before = physicalLines(text.slice(0, offset), 0);
  return { line: before.length, column: before[before.length - 1].text.length };
}

// ============================================================================
// Refusal sentences
// ============================================================================

/** A refusal found while reading a line, at a column of it, until the line's number is known. */
interface LineRefusal {
  readonly code: LexRefusalCode;
  readonly column: number;
  readonly sentence: (line: number, column: number) => string;
}

const shellSentence =
  (what: string, why: string, fix: string) =>
  (line: number, column: number): string =>
    `Studio runs no shell, so it refuses ${what} at line ${line}, column ${column}, ${why}: ${fix}.`;

const KEEP_TEXT = "write the text between single quotes to keep it as written";
const KEEP_WORD = "write the word between single quotes to keep it as written";

const DOLLAR = shellSentence(
  "the $",
  "which a shell may expand",
  "put a backslash before the $, or write the text between single quotes, to keep it as written",
);
const BACKQUOTE = shellSentence("the backquote", "which a shell reads as a command to run", KEEP_TEXT);
const TILDE = shellSentence("the ~ that begins the word", "which a shell expands to a home directory", KEEP_WORD);
const EQUALS = shellSentence("the = that begins the word", "which zsh expands to a command's path", KEEP_WORD);
const ASSIGNMENT_TILDE = shellSentence(
  "the ~ after the = or a : of the word",
  "which bash expands to a home directory",
  KEEP_WORD,
);
const BRACES = shellSentence("the braces in the word", "which a shell may expand into several words", KEEP_WORD);
const operatorSentence =
  (char: string) =>
  (line: number, column: number): string =>
    `Studio runs one etcdctl command and no shell, so it refuses the ${char} at line ${line}, column ${column}: ${KEEP_TEXT}.`;

const unclosedSentence = (kind: LexQuote, line: number, column: number): string =>
  `The ${kind} quote in the word at line ${line}, column ${column} is never closed: close it before the end of the text.`;
const trailingBackslashSentence = (line: number, column: number): string =>
  `The backslash at line ${line}, column ${column} ends the text and escapes nothing, which shells read differently (bash keeps it and zsh drops it): remove it, or write it between single quotes.`;
const surrogateSentence = (line: number, column: number): string =>
  `The text holds a lone UTF-16 surrogate at line ${line}, column ${column}, which is not a character: remove it.`;

const escapeSentence =
  (escape: string) =>
  (line: number): string =>
    `Line ${line} of the txn holds ${escape} in a double-quoted string, which is not an escape in Go's quoting, the quoting etcdctl reads a txn with: write \\\\ for a backslash.`;
const openQuoteSentence = (line: number, column: number): string =>
  `Line ${line} of the txn opens a quote at column ${column} that is never closed, which etcdctl would drop and read on: close it.`;
const adjacentSentence = (line: number, column: number): string =>
  `Line ${line} of the txn has text right after the closing quote at column ${column}, where etcdctl starts a new word and a shell would join them: put a space after the quote, or move the text inside the quotes.`;
const compareSentence =
  (what: string) =>
  (line: number): string =>
    `Line ${line} of the txn is not a compare etcdctl reads: ${what}. A compare is written as mod("key1") > "0": a target, the key in quotes inside parentheses, then an operator and a quoted value, each after a space.`;

// ============================================================================
// The command line: the POSIX shell's quoting (spec 5.1.1)
// ============================================================================

/** A command-line word's text, with one mark per UTF-16 unit: "u" unquoted, "q" quoted or escaped. */
interface WordText {
  readonly text: string;
  readonly quoting: string;
}

/** The part of a command-line word that one physical line holds. */
interface WordPart extends WordText {
  /** The part carries on a word a line before left open; otherwise the word starts on this line, at `column`. */
  readonly resumed: boolean;
  readonly column: number;
  /** The column just past the last source character the part took; undefined when it took none on this line. */
  readonly end?: number;
}

interface PartBuilder {
  text: string;
  quoting: string;
  readonly resumed: boolean;
  readonly column: number;
  end?: number;
  /** The word began on this line with an unquoted `-`, which the tokens provider draws as a flag. */
  readonly flag: boolean;
}

/** What a physical line leaves open for the next: a quote, a backslash-newline, a word. */
interface ShellCarry {
  readonly quote: LexQuote;
  readonly continued: boolean;
  readonly inWord: boolean;
}

interface ShellScan {
  readonly tokens: readonly LexToken[];
  /** The words the line finished, each as the part of it the line holds. */
  readonly words: readonly WordPart[];
  /** The part of a word the line leaves open. */
  readonly open?: WordPart;
  readonly carry: ShellCarry;
  /** Refusals of single characters: a $, a backquote, an operator. A whole word's are its reader's. */
  readonly refusals: readonly LineRefusal[];
}

/** Collects a line's tokens, merging a token into the one before it when they touch and match. */
class TokenSink {
  readonly tokens: LexToken[] = [];

  add(kind: LexTokenKind, start: number, end: number): void {
    if (end <= start) return;
    const last = this.tokens[this.tokens.length - 1];
    if (last !== undefined && last.kind === kind && last.end === start) {
      this.tokens[this.tokens.length - 1] = { kind, start: last.start, end };
    } else {
      this.tokens.push({ kind, start, end });
    }
  }
}

const isUnquoted = (quoting: string, from: number, to: number): boolean => !quoting.slice(from, to).includes("q");

/**
 * Braces a shell may expand: an unquoted pair holding, at its own level, an unquoted comma or a `..`
 * quoted or not, because zsh expands a sequence whatever the quoting of its dots (measured: zsh 5.9
 * read {1.'.'3}, {1'..'3} and {1\..3} as 1, 2 and 3, where bash 5.2.21 kept them as written).
 */
function hasBraceExpansion(text: string, quoting: string): boolean {
  const open: boolean[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const unquoted = quoting[index] === "u";
    if (char === "{" && unquoted) open.push(false);
    else if (char === "}" && unquoted) {
      if (open.pop() === true) return true;
    } else if (open.length > 0 && ((char === "," && unquoted) || (char === "." && text[index + 1] === ".")))
      open[open.length - 1] = true;
  }
  return false;
}

/** A `~` bash expands in a word shaped like an assignment: right after its `=` or after a `:`. */
function hasAssignmentTilde(text: string, quoting: string): boolean {
  const name = NAME_ASSIGNMENT.exec(text);
  if (name === null || !isUnquoted(quoting, 0, name[0].length)) return false;
  for (let index = name[0].length; index < text.length; index++) {
    if (text[index] !== "~" || quoting[index] !== "u") continue;
    if (index === name[0].length || (text[index - 1] === ":" && quoting[index - 1] === "u")) return true;
  }
  return false;
}

/** A command-line word read whole, across as many lines as it runs over, and where it starts and ends. */
interface JoinedWord extends WordText {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** The refusals only a whole word shows, at its first character. */
function wordRefusals(word: JoinedWord): LexRefusal[] {
  const sentences: LineRefusal["sentence"][] = [];
  if (word.text.startsWith("~") && word.quoting[0] === "u") sentences.push(TILDE);
  // zsh reads the rest of the word, its quotes removed, as a command's name, so a lone = stays data.
  if (word.text.length > 1 && word.text.startsWith("=") && word.quoting[0] === "u") sentences.push(EQUALS);
  if (hasAssignmentTilde(word.text, word.quoting)) sentences.push(ASSIGNMENT_TILDE);
  if (hasBraceExpansion(word.text, word.quoting)) sentences.push(BRACES);
  return sentences.map((sentence) => ({
    code: "shell-expansion",
    line: word.line,
    column: word.column,
    message: sentence(word.line, word.column + 1),
  }));
}

/** A `$` stays data only where no shell reads anything after it (measured, see the docblock). */
const dollarIsData = (next: string | undefined, insideDoubleQuotes: boolean): boolean =>
  next === undefined || isBlank(next) || (insideDoubleQuotes && next === '"');

const wordPart = (builder: PartBuilder): WordPart => ({
  text: builder.text,
  quoting: builder.quoting,
  resumed: builder.resumed,
  column: builder.column,
  ...(builder.end === undefined ? {} : { end: builder.end }),
});

/** Reads one physical line by the shell's quoting, from what the line before left open. */
function scanShellLine(line: string, carry: ShellCarry, from = 0): ShellScan {
  const sink = new TokenSink();
  const words: WordPart[] = [];
  const refusals: LineRefusal[] = [];
  let quote = carry.quote;
  let continued = false;
  let word: PartBuilder | undefined = carry.inWord
    ? { text: "", quoting: "", resumed: true, column: 0, flag: false }
    : undefined;
  // A quote open across the line break keeps the break as data, unless it was a backslash-newline.
  if (word !== undefined && (quote === "single" || (quote === "double" && !carry.continued))) {
    word.text += "\n";
    word.quoting += "q";
  }

  const take = (current: PartBuilder, text: string, mark: "u" | "q", end: number): void => {
    current.text += text;
    current.quoting += mark.repeat(text.length);
    current.end = end;
  };
  const finish = (current: PartBuilder): void => {
    words.push(wordPart(current));
    word = undefined;
  };
  const refuse = (sentence: LineRefusal["sentence"], code: LexRefusalCode, column: number): void => {
    refusals.push({ code, column, sentence });
  };

  let pos = from;
  while (pos < line.length) {
    const char = line[pos];
    if (word !== undefined && quote === "single") {
      // Everything up to the next single quote is data.
      const close = line.indexOf("'", pos);
      const end = close < 0 ? line.length : close + 1;
      take(word, line.slice(pos, close < 0 ? line.length : close), "q", end);
      sink.add("string", pos, end);
      if (close >= 0) quote = "none";
      pos = end;
      continue;
    }
    if (word !== undefined && quote === "double") {
      const next = line[pos + 1];
      if (char === '"') {
        quote = "none";
        take(word, "", "q", pos + 1);
        sink.add("string", pos, pos + 1);
        pos += 1;
      } else if (char === "\\" && next === undefined) {
        // A backslash-newline inside double quotes is removed.
        continued = true;
        take(word, "", "q", pos + 1);
        sink.add("string", pos, pos + 1);
        pos += 1;
      } else if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
        take(word, next, "q", pos + 2);
        sink.add("string", pos, pos + 2);
        pos += 2;
      } else if ((char === "$" && !dollarIsData(next, true)) || char === "`") {
        refuse(char === "$" ? DOLLAR : BACKQUOTE, "shell-expansion", pos);
        take(word, char, "q", pos + 1);
        sink.add("invalid", pos, pos + 1);
        pos += 1;
      } else {
        // Every other backslash inside double quotes is data.
        take(word, char, "q", pos + 1);
        sink.add("string", pos, pos + 1);
        pos += 1;
      }
      continue;
    }
    if (isBlank(char)) {
      if (word !== undefined) finish(word);
      const start = pos;
      while (isBlank(line[pos])) pos += 1;
      sink.add("whitespace", start, pos);
      continue;
    }
    if (word === undefined && char === "#") {
      sink.add("comment", pos, line.length);
      break;
    }
    if (SHELL_OPERATORS.has(char)) {
      if (word !== undefined) finish(word);
      refuse(operatorSentence(char), "shell-operator", pos);
      sink.add("invalid", pos, pos + 1);
      pos += 1;
      continue;
    }
    if (char === "\\" && pos === line.length - 1) {
      // A backslash-newline joins this line to the next and is removed, inside a word or not.
      continued = true;
      if (word === undefined) sink.add("whitespace", pos, pos + 1);
      else {
        take(word, "", "u", pos + 1);
        sink.add(word.flag ? "flag" : "word", pos, pos + 1);
      }
      pos += 1;
      continue;
    }
    const current: PartBuilder = word ?? { text: "", quoting: "", resumed: false, column: pos, flag: char === "-" };
    word = current;
    const kind: LexTokenKind = current.flag ? "flag" : "word";
    if (char === "\\") {
      take(current, line[pos + 1], "q", pos + 2);
      sink.add(kind, pos, pos + 2);
      pos += 2;
    } else if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      take(current, "", "q", pos + 1);
      sink.add("string", pos, pos + 1);
      pos += 1;
    } else if ((char === "$" && !dollarIsData(line[pos + 1], false)) || char === "`") {
      refuse(char === "$" ? DOLLAR : BACKQUOTE, "shell-expansion", pos);
      take(current, char, "u", pos + 1);
      sink.add("invalid", pos, pos + 1);
      pos += 1;
    } else {
      take(current, char, "u", pos + 1);
      sink.add(kind, pos, pos + 1);
      pos += 1;
    }
  }

  const open = word as PartBuilder | undefined;
  if (quote !== "none" || continued) {
    const carried: ShellCarry = { quote, continued, inWord: open !== undefined };
    if (open === undefined) return { tokens: sink.tokens, words, refusals, carry: carried };
    return { tokens: sink.tokens, words, refusals, carry: carried, open: wordPart(open) };
  }
  if (open !== undefined) finish(open);
  return { tokens: sink.tokens, words, refusals, carry: { quote: "none", continued: false, inWord: false } };
}

/** pflag's reading of a word as a flag: it begins with - and is longer than - alone. */
export const isFlagText = (text: string): boolean => text.length > 1 && text.startsWith("-");

const PROMPTS: ReadonlySet<string> = new Set(["$", "%"]);
const TIMEOUT_WORD = "--command-timeout";
const ETCDCTL_PATH = "/etcdctl";
/** One more unit than the longest word the leading tokens compare whole, so a head this long is none of them. */
const LEAD_HEAD = TIMEOUT_WORD.length + 1;

const START_LEAD_WORD: LexLeadWord = { head: "", quoting: "", tail: "", assignment: "start" };

/** The longest end of `text` that /etcdctl begins with. */
function etcdctlTail(text: string): string {
  for (let length = Math.min(text.length, ETCDCTL_PATH.length); length > 0; length--) {
    const end = text.slice(text.length - length);
    if (ETCDCTL_PATH.startsWith(end)) return end;
  }
  return "";
}

/**
 * What the leading tokens read of a word, `word` with `part` added to its end: the same as of the whole
 * word read at once. The longest end /etcdctl begins with lies within the old one and the part's last
 * units, since an end longer than the part is the old word's end with the part after it.
 */
function extendLeadWord(word: LexLeadWord, part: WordText): LexLeadWord {
  let assignment = word.assignment;
  for (let index = 0; index < part.text.length && (assignment === "start" || assignment === "name"); index++) {
    const char = part.text[index];
    if (part.quoting[index] !== "u") assignment = "no";
    else if (assignment === "name" && char === "=") assignment = "yes";
    else assignment = (assignment === "start" ? NAME_FIRST : NAME_REST).test(char) ? "name" : "no";
  }
  const room = LEAD_HEAD - word.head.length;
  return {
    head: word.head + part.text.slice(0, room),
    quoting: word.quoting + part.quoting.slice(0, room),
    tail: etcdctlTail(word.tail + part.text.slice(-ETCDCTL_PATH.length)),
    assignment,
  };
}

/** The role a command-line word takes: a leading token's, the command word's, or an argument's after it. */
type WordRole = LeadRole | "command" | "argument";

/** Where the leading tokens stand after one more word, and the role that word takes. */
interface LeadStep {
  readonly lead: LexLead;
  readonly role: WordRole;
}

/** The stages at which the leading tokens still read a word, in their order (spec 5.1.2). */
const READING: readonly LexLead[] = ["prompt", "env", "assignment", "flag"];

/**
 * What a documented command carries before its command word (spec 5.1.2), read one word at a time: a
 * prompt, `env`, a run of assignments, an `etcdctl` word that may carry a path, then global flags, where
 * `--command-timeout` written without `=` takes the next word. The parser refuses what does not belong;
 * this only finds where the command word stands.
 */
function readLeadWord(lead: LexLead, word: LexLeadWord): LeadStep {
  const stage = READING.indexOf(lead);
  if (stage <= 0 && PROMPTS.has(word.head) && word.quoting === "u") return { lead: "env", role: "prompt" };
  if (stage <= 1 && word.head === "env") return { lead: "assignment", role: "env" };
  if (stage <= 2 && word.assignment === "yes") return { lead: "assignment", role: "assignment" };
  if (stage <= 2 && (word.head === "etcdctl" || word.tail === ETCDCTL_PATH)) return { lead: "flag", role: "etcdctl" };
  if (isFlagText(word.head)) return { lead: word.head === TIMEOUT_WORD ? "flag-value" : "flag", role: "flag" };
  return { lead: word.head === "txn" ? "txn" : "command", role: "command" };
}

/** A word the leading tokens do not read: --command-timeout's value, or an argument after the command word. */
const passLeadWord = (lead: LexLead): LeadStep =>
  lead === "flag-value" ? { lead: "flag", role: "flag-value" } : { lead, role: "argument" };

// ============================================================================
// The txn body: etcdctl's own reading (spec 5.1.4)
// ============================================================================

function pushUtf8(out: number[], code: number): void {
  if (code < 0x80) out.push(code);
  else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
}

const NAMED_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};
const HEX_DIGITS: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };
const HEX = /^[0-9a-fA-F]+$/;
const OCTAL = /^[0-7]{3}$/;

type GoUnquote =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "escape"; readonly at: number; readonly escape: string };

/**
 * The inside of a double-quoted Go string to bytes, as strconv.Unquote decodes it: `\xNN` and an
 * octal escape are one byte each, `\u` and `\U` a code point as UTF-8 (a surrogate or a value
 * past U+10FFFF refused), a literal character its UTF-8, and any other escape refused. The caller
 * guarantees that no backslash ends the text.
 */
function goUnquote(content: string): GoUnquote {
  const out: number[] = [];
  let index = 0;
  while (index < content.length) {
    if (content[index] !== "\\") {
      const code = content.codePointAt(index) as number;
      pushUtf8(out, code);
      index += code > 0xffff ? 2 : 1;
      continue;
    }
    const letter = content[index + 1];
    const named = NAMED_ESCAPES[letter];
    if (named !== undefined) {
      out.push(named);
      index += 2;
      continue;
    }
    const digits = HEX_DIGITS[letter];
    if (digits !== undefined) {
      const hex = content.slice(index + 2, index + 2 + digits);
      const value = Number.parseInt(hex, 16);
      const valid =
        hex.length === digits &&
        HEX.test(hex) &&
        (letter === "x" || value < 0xd800 || (value > 0xdfff && value <= 0x10ffff));
      if (!valid) return { kind: "escape", at: index, escape: content.slice(index, index + 2 + digits) };
      if (letter === "x") out.push(value);
      else pushUtf8(out, value);
      index += 2 + digits;
      continue;
    }
    const octal = content.slice(index + 1, index + 4);
    if (letter >= "0" && letter <= "7" && OCTAL.test(octal) && Number.parseInt(octal, 8) <= 0xff) {
      out.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }
    const length = letter >= "0" && letter <= "7" ? 4 : 2;
    return { kind: "escape", at: index, escape: content.slice(index, index + length) };
  }
  return { kind: "ok", bytes: new Uint8Array(out) };
}

type DoubleQuoted =
  | { readonly kind: "ok"; readonly bytes: Uint8Array; readonly end: number }
  | { readonly kind: "unterminated" }
  | { readonly kind: "escape"; readonly at: number; readonly escape: string; readonly end: number };

type GoQuoted = DoubleQuoted | { readonly kind: "not-quoted" };

/** A double-quoted Go string whose opening quote is at `from`. */
function readDoubleQuoted(line: string, from: number, to: number): DoubleQuoted {
  let index = from + 1;
  // fmt protects the character after a backslash, so an escaped quote does not close the string.
  while (index < to && line[index] !== '"') index += line[index] === "\\" ? 2 : 1;
  if (index >= to) return { kind: "unterminated" };
  const decoded = goUnquote(line.slice(from + 1, index));
  if (decoded.kind === "escape")
    return { kind: "escape", at: from + 1 + decoded.at, escape: decoded.escape, end: index + 1 };
  return { kind: "ok", bytes: decoded.bytes, end: index + 1 };
}

/** fmt's %q verb at `from`: a double-quoted Go string, or a raw string in backquotes. */
function readGoQuoted(line: string, from: number, to: number): GoQuoted {
  const open = line[from];
  if (from >= to || (open !== '"' && open !== "`")) return { kind: "not-quoted" };
  if (open === '"') return readDoubleQuoted(line, from, to);
  const close = line.indexOf("`", from + 1);
  if (close < 0 || close >= to) return { kind: "unterminated" };
  return { kind: "ok", bytes: encoder.encode(line.slice(from + 1, close)), end: close + 1 };
}

const skipGoSpace = (line: string, from: number, to: number): number => {
  let index = from;
  while (index < to && isGoSpace(line[index])) index += 1;
  return index;
};

/** A word read from a txn line, placed on that line. */
interface BodyWord {
  readonly bytes: Uint8Array;
  readonly column: number;
  readonly endColumn: number;
}

interface CompareParts {
  readonly target: BodyWord;
  readonly key: BodyWord;
  readonly operator: BodyWord;
  readonly value: BodyWord;
  readonly rest: string;
}

interface BodyReading {
  readonly words?: readonly BodyWord[];
  readonly compare?: CompareParts;
  readonly refusals: readonly LineRefusal[];
}

const bodyWord = (line: string, column: number, endColumn: number): BodyWord => ({
  bytes: encoder.encode(line.slice(column, endColumn)),
  column,
  endColumn,
});

/**
 * One compare, read as fmt.Sscanf(rest, "%q) %s %q") reads what follows the first `(`: spaces
 * may come before the key, the `)` must follow its closing quote at once, and the operator and
 * the value each come after at least one space (fmt's own space set). The target is everything
 * before the `(`, and text after the value, which Sscanf ignores, is kept for the parser.
 */
function readCompare(line: string, from: number, to: number, sink: TokenSink): BodyReading {
  const shape = (what: string): BodyReading => {
    sink.add("invalid", from, to);
    return { refusals: [{ code: "txn-syntax", column: from, sentence: compareSentence(what) }] };
  };
  type Part = { readonly bytes: Uint8Array; readonly end: number };
  const quoted = (at: number, part: "key" | "value"): Part | BodyReading => {
    const read = readGoQuoted(line, at, to);
    if (read.kind === "not-quoted") return shape(`the ${part} is not a quoted string`);
    if (read.kind === "unterminated") return shape(`the ${part}'s quote is never closed`);
    if (read.kind === "escape") {
      sink.add("invalid", from, to);
      return {
        refusals: [{ code: "txn-quoting", column: read.at, sentence: escapeSentence(read.escape) }],
      };
    }
    return { bytes: read.bytes, end: read.end };
  };
  const isPart = (value: Part | BodyReading): value is Part => "bytes" in value;

  const paren = line.indexOf("(", from);
  if (paren < 0 || paren >= to) return shape("it holds no (");
  const keyAt = skipGoSpace(line, paren + 1, to);
  const key = quoted(keyAt, "key");
  if (!isPart(key)) return key;
  if (line[key.end] !== ")") return shape("no ) follows the key's closing quote");
  if (key.end + 1 >= to) return shape("no operator follows the key");
  if (!isGoSpace(line[key.end + 1])) return shape("no space follows the )");
  const operatorAt = skipGoSpace(line, key.end + 1, to);
  let operatorEnd = operatorAt;
  while (operatorEnd < to && !isGoSpace(line[operatorEnd])) operatorEnd += 1;
  if (operatorEnd >= to) return shape("no value follows the operator");
  const valueAt = skipGoSpace(line, operatorEnd, to);
  const value = quoted(valueAt, "value");
  if (!isPart(value)) return value;

  sink.add("word", from, paren);
  sink.add("operator", paren, paren + 1);
  sink.add("whitespace", paren + 1, keyAt);
  sink.add("string", keyAt, key.end);
  sink.add("operator", key.end, key.end + 1);
  sink.add("whitespace", key.end + 1, operatorAt);
  sink.add("operator", operatorAt, operatorEnd);
  sink.add("whitespace", operatorEnd, valueAt);
  sink.add("string", valueAt, value.end);
  if (value.end < to) sink.add("invalid", value.end, to);
  return {
    refusals: [],
    compare: {
      target: bodyWord(line, from, paren),
      key: { bytes: key.bytes, column: keyAt, endColumn: key.end },
      operator: bodyWord(line, operatorAt, operatorEnd),
      value: { bytes: value.bytes, column: valueAt, endColumn: value.end },
      rest: line.slice(value.end, to),
    },
  };
}

/**
 * One request line, split as Argify's `"(?:[^"\\]|\\.)*"|'[^']*'|[^'"\s]\S*[^'"\s]?` splits it:
 * a double-quoted word is a Go string, a single-quoted word is literal, and any other word runs
 * to the next \s, taken as written. Argify starts a new word right after a closing quote and
 * drops a quote that never closes; both are refused here instead.
 */
function readRequest(line: string, from: number, to: number, sink: TokenSink): BodyReading {
  const words: BodyWord[] = [];
  const refusals: LineRefusal[] = [];
  const openQuote = (at: number): void => {
    refusals.push({ code: "txn-quoting", column: at, sentence: openQuoteSentence });
    sink.add("invalid", at, at + 1);
  };
  const closed = (end: number): void => {
    if (end < to && !isArgifySpace(line[end]))
      refusals.push({ code: "txn-quoting", column: end, sentence: adjacentSentence });
  };
  let pos = from;
  while (pos < to) {
    const char = line[pos];
    if (isArgifySpace(char)) {
      const start = pos;
      while (pos < to && isArgifySpace(line[pos])) pos += 1;
      sink.add("whitespace", start, pos);
    } else if (char === '"') {
      const read = readDoubleQuoted(line, pos, to);
      if (read.kind === "unterminated") {
        openQuote(pos);
        pos += 1;
        continue;
      }
      if (read.kind === "escape") {
        refusals.push({ code: "txn-quoting", column: read.at, sentence: escapeSentence(read.escape) });
        sink.add("invalid", pos, read.end);
      } else {
        words.push({ bytes: read.bytes, column: pos, endColumn: read.end });
        sink.add("string", pos, read.end);
      }
      pos = read.end;
      closed(pos);
    } else if (char === "'") {
      const close = line.indexOf("'", pos + 1);
      if (close < 0 || close >= to) {
        openQuote(pos);
        pos += 1;
        continue;
      }
      words.push({ bytes: encoder.encode(line.slice(pos + 1, close)), column: pos, endColumn: close + 1 });
      sink.add("string", pos, close + 1);
      pos = close + 1;
      closed(pos);
    } else {
      const start = pos;
      while (pos < to && !isArgifySpace(line[pos])) pos += 1;
      sink.add(words.length > 0 && char === "-" ? "flag" : "word", start, pos);
      words.push(bodyWord(line, start, pos));
    }
  }
  return { words, refusals };
}

// ============================================================================
// One line, in whichever section it falls (spec 3.3)
// ============================================================================

const NEXT_BODY_SECTION: Readonly<Record<string, LexSection>> = {
  compares: "success",
  success: "failure",
  failure: "after-body",
  "after-body": "after-body",
};

interface LineReading {
  readonly tokens: readonly LexToken[];
  readonly state: LexState;
  readonly role: LexLineRole;
  /** The command-line words the line finished, each as the part of it the line holds, and each one's role. */
  readonly parts: readonly WordPart[];
  readonly roles: readonly WordRole[];
  /** The part of a command-line word the line leaves open. */
  readonly open?: WordPart;
  readonly body?: BodyReading;
  readonly refusals: readonly LineRefusal[];
}

function readCommandLine(line: string, state: LexState): LineReading {
  const scan = scanShellLine(line, state);
  // A word the line before left open is read on from what the state kept of it, which is all the leading
  // tokens read of it while they still read words.
  const leadWordOf = (part: WordPart): LexLeadWord =>
    extendLeadWord(part.resumed ? (state.leadWord as LexLeadWord) : START_LEAD_WORD, part);
  let lead = state.lead;
  const roles: WordRole[] = [];
  for (const part of scan.words) {
    const step = READING.includes(lead) ? readLeadWord(lead, leadWordOf(part)) : passLeadWord(lead);
    lead = step.lead;
    roles.push(step.role);
  }
  // A line that resumes a word finishes it, which moves the lead past "prompt", or leaves it open.
  const logical = lead !== "prompt" || scan.open !== undefined;
  const role: LexLineRole = logical ? "command" : scan.tokens.some((t) => t.kind === "comment") ? "comment" : "blank";
  let next: LexState;
  if (scan.carry.quote !== "none" || scan.carry.continued) {
    next = { section: "command", ...scan.carry, lead };
    if (scan.open !== undefined && READING.includes(lead)) next = { ...next, leadWord: leadWordOf(scan.open) };
  } else if (lead === "prompt") {
    next = INITIAL_LEX_STATE;
  } else {
    next = { ...INITIAL_LEX_STATE, section: lead === "txn" ? "compares" : "after-command" };
  }
  return { tokens: scan.tokens, state: next, role, parts: scan.words, roles, open: scan.open, refusals: scan.refusals };
}

function readAfterCommandLine(line: string, state: LexState): LineReading {
  const sink = new TokenSink();
  let start = 0;
  while (isBlank(line[start])) start += 1;
  if (start > 0) sink.add("whitespace", 0, start);
  let role: LexLineRole = "blank";
  if (start < line.length) {
    role = line[start] === "#" ? "comment" : "content";
    sink.add(role === "comment" ? "comment" : "invalid", start, line.length);
  }
  return { tokens: sink.tokens, state, role, parts: [], roles: [], refusals: [] };
}

function readBodyLine(line: string, state: LexState): LineReading {
  const sink = new TokenSink();
  let from = 0;
  let to = line.length;
  while (from < to && isGoSpace(line[from])) from += 1;
  while (to > from && isGoSpace(line[to - 1])) to -= 1;
  if (from > 0) sink.add("whitespace", 0, from);
  const done = (role: LexLineRole, body?: BodyReading, next: LexState = state): LineReading => {
    if (to < line.length) sink.add("whitespace", to, line.length);
    return { tokens: sink.tokens, state: next, role, parts: [], roles: [], body, refusals: body?.refusals ?? [] };
  };
  if (from === to) return done("blank", undefined, { ...state, section: NEXT_BODY_SECTION[state.section] });
  if (line[from] === "#") {
    sink.add("comment", from, to);
    return done("comment");
  }
  if (state.section === "after-body") {
    sink.add("invalid", from, to);
    return done("content");
  }
  if (state.section === "compares") return done("compare", readCompare(line, from, to, sink));
  return done("request", readRequest(line, from, to, sink));
}

function readLine(line: string, state: LexState): LineReading {
  if (state.section === "command") return readCommandLine(line, state);
  if (state.section === "after-command") return readAfterCommandLine(line, state);
  return readBodyLine(line, state);
}

/** One physical line, read from the state the line before it left (spec 3.3). */
export function tokenizeLine(
  line: string,
  state: LexState,
): { readonly tokens: readonly LexToken[]; readonly state: LexState } {
  const reading = readLine(line, state);
  return { tokens: reading.tokens, state: reading.state };
}

// ============================================================================
// The whole text, line by line
// ============================================================================

const toWord = (bytes: Uint8Array, text: string, start: [number, number], end: [number, number]): Word => ({
  text,
  bytes,
  line: start[0],
  column: start[1],
  endLine: end[0],
  endColumn: end[1],
});

const commandWord = (word: JoinedWord): Word =>
  toWord(encoder.encode(word.text), word.text, [word.line, word.column], [word.endLine, word.endColumn]);

/** `part` added to the word a line before left open, or a word of its own when it starts on `line`. */
function joinPart(open: JoinedWord | undefined, part: WordPart, line: number): JoinedWord {
  // A part that starts its word took its first character, so it has an end.
  if (!part.resumed) {
    const end = part.end as number;
    return { text: part.text, quoting: part.quoting, line, column: part.column, endLine: line, endColumn: end };
  }
  // A line resumes a word only when the line before left one open.
  const word = open as JoinedWord;
  return {
    ...word,
    text: word.text + part.text,
    quoting: word.quoting + part.quoting,
    ...(part.end === undefined ? {} : { endLine: line, endColumn: part.end }),
  };
}

/**
 * The whole words a line's parts finish and the word it leaves open. Only a line's first part can resume
 * the word a line before left open, and its open part only when it finishes none.
 */
function joinLine(
  open: JoinedWord | undefined,
  parts: readonly WordPart[],
  rest: WordPart | undefined,
  line: number,
): { readonly words: readonly JoinedWord[]; readonly open: JoinedWord | undefined } {
  const words = parts.map((part) => joinPart(open, part, line));
  return { words, open: rest === undefined ? undefined : joinPart(open, rest, line) };
}

function lineWord(word: BodyWord, line: number): Word {
  return toWord(word.bytes, lossyDecoder.decode(word.bytes), [line, word.column], [line, word.endColumn]);
}

const placeRefusal = (refusal: LineRefusal, line: number): LexRefusal => ({
  code: refusal.code,
  line,
  column: refusal.column,
  message: refusal.sentence(line, refusal.column + 1),
});

const earliest = (refusals: readonly LexRefusal[]): LexRefusal =>
  refusals.reduce((first, next) =>
    next.line < first.line || (next.line === first.line && next.column < first.column) ? next : first,
  );

/** What a text still holds open when it ends: a quote, or a backslash-newline with no next line. */
function openAtEnd(
  state: ShellCarry,
  open: JoinedWord | undefined,
  lastText: string,
  lastLine: number,
): LexRefusal | undefined {
  if (state.quote !== "none") {
    // A quote opens inside a word, so a word is open.
    const { line, column } = open as JoinedWord;
    return { code: "unclosed-quote", line, column, message: unclosedSentence(state.quote, line, column + 1) };
  }
  if (state.continued) {
    const column = lastText.length - 1;
    return {
      code: "trailing-backslash",
      line: lastLine,
      column,
      message: trailingBackslashSentence(lastLine, column + 1),
    };
  }
  return undefined;
}

function refuseLoneSurrogate(text: string): LexRefusal | undefined {
  const at = loneSurrogateAt(text);
  if (at < 0) return undefined;
  const { line, column } = positionOf(text, at);
  return { code: "not-text", line, column, message: surrogateSentence(line, column + 1) };
}

/**
 * Every line of a text read in turn, the command line by the shell's rule and a txn body by
 * etcdctl's (spec 5.1.1, 5.1.4). A command line that cannot be read as words refuses the text,
 * with its earliest refusal; a txn body line that does not read carries its refusal on the line,
 * so the parser reports the body's first problem in line order.
 */
export function splitWords(text: string): SplitResult {
  const surrogate = refuseLoneSurrogate(text);
  if (surrogate !== undefined) return { ok: false, refusal: surrogate };
  const physical = physicalLines(text, 0);
  const lines: SplitLine[] = [];
  const command: Word[] = [];
  const roles: LeadRole[] = [];
  let commandIndex: number | undefined;
  const refusals: LexRefusal[] = [];
  let open: JoinedWord | undefined;
  let state = INITIAL_LEX_STATE;
  physical.forEach(({ text: lineText }, index) => {
    const line = index + 1;
    const reading = readLine(lineText, state);
    const placed = reading.refusals.map((refusal) => placeRefusal(refusal, line));
    const joined = joinLine(open, reading.parts, reading.open, line);
    joined.words.forEach((word, position) => {
      placed.push(...wordRefusals(word));
      command.push(commandWord(word));
      const role = reading.roles[position];
      if (role === "command") commandIndex = command.length - 1;
      else if (role !== "argument") roles.push(role);
    });
    open = joined.open;
    const body = reading.body;
    const start = reading.tokens.find((token) => token.kind !== "whitespace")?.start ?? lineText.length;
    let entry: SplitLine = { line, text: lineText, start, section: state.section, role: reading.role };
    if (body === undefined) refusals.push(...placed);
    else if (placed.length > 0) entry = { ...entry, refusal: earliest(placed) };
    else if (body.compare !== undefined) {
      const { target, key, operator, value, rest } = body.compare;
      entry = {
        ...entry,
        compare: {
          target: lineWord(target, line),
          key: lineWord(key, line),
          operator: lineWord(operator, line),
          value: lineWord(value, line),
          rest,
        },
      };
    } else entry = { ...entry, words: (body.words ?? []).map((word) => lineWord(word, line)) };
    lines.push(entry);
    state = reading.state;
  });
  if (state.section === "command") {
    const refusal = openAtEnd(state, open, physical[physical.length - 1].text, physical.length);
    if (refusal !== undefined) refusals.push(refusal);
  }
  if (refusals.length > 0) return { ok: false, refusal: earliest(refusals) };
  // With no command word, its index is the count of the words, as LeadingTokens states.
  return { ok: true, split: { lines, command, lead: { roles, commandIndex: commandIndex ?? command.length } } };
}

/**
 * The words of one logical line of `text`, the first that starts at `startOffset`, by the command
 * line's rule: a backslash-newline joins lines, and a quote may run across them. `nextOffset` is
 * where the next logical line starts.
 */
export function lexLogicalLine(
  text: string,
  startOffset: number,
):
  | { readonly ok: true; readonly words: readonly Word[]; readonly nextOffset: number }
  | { readonly ok: false; readonly refusal: LexRefusal } {
  const first = positionOf(text, startOffset);
  // Lines are read whole, so a column counts from its line's start; the first is read from the offset.
  const physical = physicalLines(text, startOffset - first.column);
  const words: Word[] = [];
  const refusals: LexRefusal[] = [];
  let carry: ShellCarry = { quote: "none", continued: false, inWord: false };
  let open: JoinedWord | undefined;
  for (let index = 0; index < physical.length; index++) {
    const line = first.line + index;
    const from = index === 0 ? first.column : 0;
    const lineText = physical[index].text;
    const surrogate = loneSurrogateAt(lineText.slice(from));
    if (surrogate >= 0) {
      const column = from + surrogate;
      return { ok: false, refusal: { code: "not-text", line, column, message: surrogateSentence(line, column + 1) } };
    }
    const scan = scanShellLine(lineText, carry, from);
    refusals.push(...scan.refusals.map((refusal) => placeRefusal(refusal, line)));
    const joined = joinLine(open, scan.words, scan.open, line);
    for (const word of joined.words) {
      refusals.push(...wordRefusals(word));
      words.push(commandWord(word));
    }
    open = joined.open;
    carry = scan.carry;
    if (carry.quote === "none" && !carry.continued) {
      if (refusals.length > 0) return { ok: false, refusal: earliest(refusals) };
      return { ok: true, words, nextOffset: physical[index].next };
    }
  }
  const lastLine = first.line + physical.length - 1;
  const unclosed = openAtEnd(carry, open, physical[physical.length - 1].text, lastLine) as LexRefusal;
  return { ok: false, refusal: earliest([...refusals, unclosed]) };
}

// ============================================================================
// Quoting, one function per rule (spec 5.5, 6.4)
// ============================================================================

const BARE_ASCII: ReadonlySet<string> = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:@%+=,^",
);

const GO_PRINTED = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/**
 * Go's strconv.IsPrint for a character past ASCII, which decides whether %q writes it as itself: the
 * letters, marks, numbers, punctuation and symbols. Every other rune (a control, a format character
 * such as a bidi override or a zero-width space, a space, a separator, private use, unassigned) Go
 * escapes. The categories are the runtime's: Bun 1.4.2 and Node 24.14.0 place every scalar value as
 * Go 1.27 (Unicode 17.0.0) does, measured over all of them, and a runtime with older tables escapes
 * more, which reads back the same.
 */
const isGoPrint = (char: string): boolean => GO_PRINTED.test(char);

/**
 * Whether `text` holds a rune Go's strconv.IsPrint rejects, which %q writes as an escape because it
 * does not show as itself: an ASCII control or DEL, or a character past ASCII that `isGoPrint` refuses
 * (a C1 control, a format character such as a bidi override or a zero-width space, a space other than
 * U+0020, a separator, private use, unassigned). The quote and the backslash, which %q escapes but
 * which print, are not among them (spec 5.5).
 */
export function holdsUnprintedRune(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x80 ? code < 0x20 || code === 0x7f : !isGoPrint(char)) return true;
  }
  return false;
}

/**
 * A word that reads back as itself in both word rules and in a shell, so it needs no quotes:
 * letters, digits and `_-./:@%+=,^`, and the characters past ASCII that Go's %q prints as
 * themselves, but never a word that begins with `=`: zsh expands one that holds more than the `=`
 * to a command's path (measured: zsh 5.9 read =ls as /usr/bin/ls), which the command line's rule
 * refuses, and a lone `=` is quoted as well, which reads back the same. It is conservative on
 * purpose: glob characters, which the lexer reads as data, are quoted too, so a generated command
 * also pastes into a shell as written, and so is every character Go would escape, so no invisible
 * or reordering character is shown bare (spec 5.5).
 */
function isBare(text: string): boolean {
  if (text === "" || text.startsWith("=")) return false;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80 ? !BARE_ASCII.has(char) : !isGoPrint(char)) return false;
  }
  return true;
}

/**
 * The command line's quoting: `text` bare when it reads back as itself, else in single quotes
 * with `'\''` for each single quote, so the typed confirmation shows the text a user types
 * (spec 5.5) and a generated form runs as written (spec 6.4). A word that begins with `-` is left
 * as it is; the caller writes it after `--`. A carriage return has no spelling on the command
 * line, since the editor ends a line at it, so quoting one throws, as a lone surrogate does.
 */
export function quoteWord(text: string): string {
  if (text.includes("\r"))
    throw new Error(
      "A carriage return has no spelling on the etcd command line, where the editor ends a line at it: write the word in a txn, where quoteTxnWord escapes it",
    );
  if (loneSurrogateAt(text) >= 0) throw new Error("A lone UTF-16 surrogate is not text, so no quoting reads it back");
  if (isBare(text)) return text;
  return `'${text.split("'").join("'\\''")}'`;
}

const hex2 = (value: number): string => value.toString(16).padStart(2, "0");

/**
 * How many bytes a UTF-8 character beginning with `lead` spans, read from its leading bits. Whether the
 * bytes are a character at all is the strict decoder's to say: it refuses a byte that begins none.
 */
const utf8Span = (lead: number): number => (lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4);

const GO_NAMED: Readonly<Record<number, string>> = {
  0x07: "\\a",
  0x08: "\\b",
  0x0c: "\\f",
  0x0a: "\\n",
  0x0d: "\\r",
  0x09: "\\t",
  0x0b: "\\v",
  0x5c: "\\\\",
  0x22: '\\"',
};

/** Go's %q for one character: as strconv.Quote writes an ASCII one, and any other as itself or as `\u` or `\U`. */
function goEscapeChar(char: string): string {
  const code = char.codePointAt(0) as number;
  if (code >= 0x80) {
    if (isGoPrint(char)) return char;
    return code > 0xffff ? `\\U${code.toString(16).padStart(8, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  }
  const named = GO_NAMED[code];
  if (named !== undefined) return named;
  return code < 0x20 || code === 0x7f ? `\\x${hex2(code)}` : char;
}

/**
 * Go's %q, as strconv.Quote writes it, for a compare's key and value and a txn request word that is
 * not bare (spec 5.1.4, 5.5, 6.4): the named escapes, `\xNN` for another ASCII control, `\u` or `\U`
 * for every other rune Go does not print, and every other character as itself. Where the bytes are
 * not UTF-8, each byte that begins no character is written as `\xNN`, one byte at a time, as
 * strconv.Quote writes it and strconv.Unquote reads it back, and the characters around it as above.
 */
export function quoteGoString(bytes: Uint8Array): string {
  let out = '"';
  let index = 0;
  while (index < bytes.length) {
    const span = utf8Span(bytes[index]);
    const char = decodeStrict(bytes.subarray(index, index + span));
    if (char === undefined) {
      out += `\\x${hex2(bytes[index])}`;
      index += 1;
    } else {
      out += goEscapeChar(char);
      index += span;
    }
  }
  return `${out}"`;
}

/** A txn request word: bare when it is safe text, else Go-quoted (spec 4.5, 6.4). */
export function quoteTxnWord(bytes: Uint8Array): string {
  const text = decodeStrict(bytes);
  return text !== undefined && isBare(text) ? text : quoteGoString(bytes);
}

// ============================================================================
// The refresh pattern: the command word as a regular expression (spec 6.2)
// ============================================================================

/**
 * A line end as `physicalLines` ends one: a CRLF, a lone CR or an LF (spec 5.1.1). A CR followed by an LF ends a
 * line only as the CRLF's first half, so a CRLF has one reading: were that CR also a line end of its own, the blank
 * lines after a comment line could take the LF, and n CRLF comment lines would have 2^n readings, all tried before
 * a read is answered.
 */
const LINE_END = String.raw`(?:\r\n|\r(?!\n)|\n)`;

/** A backslash-newline at a CRLF, CR or LF line end, which joins two lines outside single quotes (spec 5.1.1). */
const LINE_JOIN = String.raw`\\${LINE_END}`;

/** A comment line: a `#` that begins its first word, and the rest of the line, up to and including its end. */
const COMMENT_LINE = String.raw`#[^\r\n]*${LINE_END}`;

/** Quote marks, which a word may hold anywhere: the lexer removes them and keeps the text they quote (spec 5.1.1). */
const QUOTES = `['"]*`;

/** The blanks between two words of the command line, with a line join before them, after them or both. */
const WORD_GAP = String.raw`(?:${LINE_JOIN})?[ \t]+(?:${LINE_JOIN}[ \t]*)?`;

/** Blank lines before the command, a line join among them. */
const BLANK_LINES = String.raw`\s*(?:\\[\r\n]\s*)*`;

/** `text` from inside a word on: each character bare or escaped, with quote marks between them and after the last. */
function spelledFrom(text: string): string {
  const characters = [...text].map((char) => String.raw`\\?${char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`);
  return `${characters.join(QUOTES)}${QUOTES}`;
}

/** A word whose text is `text`, as the lexer reads it (spec 5.1.1). */
const spelledWord = (text: string): string => `${QUOTES}${spelledFrom(text)}`;

/** Characters the lexer keeps as they stand outside quotes: all but a blank, a line end, a quote or a backslash. */
const BARE_RUN = String.raw`[^ \t\r\n'"\\]*`;

/** Single-quoted text up to its closing quote, all of which the lexer keeps, a line break and a backslash too. */
const SINGLE_QUOTED = `'[^']*`;

/** Double-quoted text up to its closing quote, a line break among it, and a backslash with the character after it. */
const DOUBLE_QUOTED = String.raw`"[^"\\]*(?:\\[^\r\n][^"\\]*)*`;

/** An escaped character, or quoted text with its closing quote. */
const ESCAPED_OR_QUOTED = String.raw`(?:\\[^\r\n]|${SINGLE_QUOTED}'|${DOUBLE_QUOTED}")`;

/** The last slash of a path: bare, escaped, or in quotes that may stay open over `etcdctl`. */
const LAST_SLASH = String.raw`(?:\\?/|${SINGLE_QUOTED}/|${DOUBLE_QUOTED}\\?/)`;

/**
 * The path before `etcdctl` (spec 5.1.2), up to its last slash: runs of bare characters between escaped
 * characters and closed quotes, so it may hold blanks, quoted or escaped, and quoted line breaks, and never
 * an unquoted `#` first, since a word that begins with one begins a comment line instead. Written one
 * unit at a time, `(?:bare|escaped|quoted)*`, it stopped matching at a path of 147,000 characters in
 * JavaScriptCore, which keeps a backtracking record for each unit and answers no match past its limit; as runs
 * it keeps one for each escape or quote, and matched a bare path of four million (measured 2026-10-01).
 */
const PATH_TO_ETCDCTL = `(?:(?!#)${BARE_RUN}(?:${ESCAPED_OR_QUOTED}${BARE_RUN})*${LAST_SLASH})`;

/** `--command-timeout` and its value, after `=` or a gap, then the gap before the next word (spec 5.1.2). */
const COMMAND_TIMEOUT = String.raw`${spelledWord("--command-timeout")}(?:\\?=|${WORD_GAP})\S+${WORD_GAP}`;

/** `lease grant` and `lease revoke`, which add and remove what the Leases folder lists (spec 6.2). */
const LEASE_WRITE = [
  spelledWord("lease"),
  WORD_GAP,
  `(?:${COMMAND_TIMEOUT})*`,
  `(?:${spelledWord("grant")}|${spelledWord("revoke")})`,
].join("");

/**
 * The pattern the provider declares as `schemaRefreshPattern` (keyvalue/etcd/index.ts), which reloads the tree
 * after a put, del, txn, lease grant or lease revoke: a new or removed key can add or remove a prefix group, and a
 * lease grant or revoke changes the Leases folder (spec 6.2). It restates this module's command-line rules, so it
 * is built here, beside them.
 *
 * Anchored to the command word the parser reads (spec 6.2): past the blank and comment lines before it, each
 * ending at a CRLF, a CR or an LF, the leading tokens of spec 5.1.2 and `--command-timeout`, so a key named
 * like a verb reloads nothing, and the command word ends where a word ends, at a blank, a line end or the end
 * of the text, so a word that goes on past it, through a no-break space or a form feed, is not it. Each word
 * may be spelled as the lexer reads it (5.1.1), with quote marks anywhere in it and any character escaped, and
 * the path before `etcdctl` may hold any text the lexer keeps in one word, quoted or escaped blanks and quoted
 * line breaks among it. A line join may stand before the blanks between two words and another after them, so
 * the documented multi-line forms reload the tree. Not read: a line join inside a word, two joins side by side,
 * and a join after a second run of blanks. Patterns that read them took JavaScriptCore, the engine of Bun and
 * Safari, 6.8 s on 20,000 joins in one gap and 38 s on 80,000 assignments (measured 2026-10-01), where this one
 * decides each in under 0.25 s. A CRLF has one reading (`LINE_END`), so 80,000 CRLF comment lines above a read
 * take it 45 ms in JavaScriptCore, where a pattern that also read their CR as a line end of its own took 2.7 s
 * there and 43 s in V8 on 26 of them (measured 2026-10-02). One reading goes the other way: a path whose quoted
 * text itself holds etcdctl and a write command, such as '/etcdctl put /x/etcdctl', reloads the tree whatever
 * command follows it.
 * `shouldRefreshSchema` compiles it with `i` alone, so `^` is the start of the whole buffer.
 */
export const ETCD_SCHEMA_REFRESH_PATTERN = [
  String.raw`^(?:${BLANK_LINES}${COMMENT_LINE})*${BLANK_LINES}`,
  `(?:[$%]${WORD_GAP})?`,
  `(?:${spelledWord("env")}${WORD_GAP})?`,
  `(?:ETCDCTL_API=${QUOTES}${spelledFrom("3")}${WORD_GAP})*`,
  `(?:${PATH_TO_ETCDCTL}?${QUOTES}${spelledFrom("etcdctl")}${WORD_GAP})?`,
  `(?:${COMMAND_TIMEOUT})*`,
  `(?:${["put", "del", "txn"].map(spelledWord).join("|")}|${LEASE_WRITE})`,
  String.raw`(?=(?:${LINE_JOIN})?(?:[ \t\r\n]|$))`,
].join("");
