/**
 * One command line, read as words by the POSIX shell's quoting rules.
 *
 * Pure, and shipped to the browser: a console's parser, its confirmation gate and its editor's tokens provider all
 * read the text through this module, so a word the editor draws as one word is the word that runs. It imports
 * nothing and names no engine.
 *
 * A console that takes a command written for a shell runs no shell, so text a shell would expand or reject is
 * refused here rather than taken literally, which would read another word than the one the user meant. What a
 * shell does was measured against bash 5.2.21, dash and zsh 5.9: a `$` before anything but a blank, the end of the
 * word or a closing double quote, a backquote, a `~` that begins a word or follows the `=` or a `:` of an unquoted
 * `NAME=` word, an unquoted `=` that begins a word holding more than it, braces holding an unquoted comma or a `..`
 * quoted or not, a backslash that ends the text, and `;`, `&`, `|`, `<`, `>`, `(` and `)`. Glob characters stay
 * data, as a shell passes them when nothing matches.
 *
 * The text holds one command line: blank and comment lines may stand before and after it, a backslash-newline joins
 * two lines, and a quote may run across lines. `tokenizeShellLine` reads one physical line from a state, which is
 * what a tokens provider calls; `readShellCommand` applies the same reading to every line in turn, which is what a
 * parser calls, so the two cannot disagree. The state is five small values whatever the text holds. Lines end at
 * CRLF, CR or LF, as the editor's model ends them.
 */

export type ShellQuote = "none" | "single" | "double";

/** "before" up to the command line (blank and comment lines), "command" inside it, "after" past it. */
export type ShellSection = "before" | "command" | "after";

export interface ShellLineState {
  readonly section: ShellSection;
  readonly quote: ShellQuote;
  /** The line just read ended with a backslash-newline outside single quotes. */
  readonly continued: boolean;
  /** A word runs on past the end of the line just read. */
  readonly inWord: boolean;
  /** How many words of the command line were finished before this line; capped at 8, which no lead needs past. */
  readonly wordsBefore: number;
}

export const INITIAL_SHELL_LINE_STATE: ShellLineState = Object.freeze({
  section: "before",
  quote: "none",
  continued: false,
  inWord: false,
  wordsBefore: 0,
});

export function shellLineStatesEqual(a: ShellLineState, b: ShellLineState): boolean {
  return (
    a.section === b.section &&
    a.quote === b.quote &&
    a.continued === b.continued &&
    a.inWord === b.inWord &&
    a.wordsBefore === b.wordsBefore
  );
}

export type ShellTokenKind = "word" | "flag" | "string" | "comment" | "whitespace" | "invalid";

export interface ShellToken {
  readonly kind: ShellTokenKind;
  /** 0-based offsets in the physical line. */
  readonly start: number;
  readonly end: number;
  /** For a word token: the index of the word it belongs to among the command line's words, when known. */
  readonly wordIndex?: number;
}

export interface ShellWord {
  readonly text: string;
  /** Whether any character of the word was quoted or escaped: a quoted "--" or "-x" is never a flag. */
  readonly quoted: boolean;
  /** 1-based line and 0-based column of the first source character; end is exclusive. */
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export type ShellRefusalCode =
  | "unclosed-quote"
  | "trailing-backslash"
  | "shell-expansion"
  | "shell-operator"
  | "not-text"
  | "second-command";

export interface ShellRefusal {
  readonly code: ShellRefusalCode;
  /** The whole sentence; names a place in the text and never quotes a value. */
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** The text's one command line as words; `words` is empty when the text holds only blank and comment lines. */
export type ShellReading =
  | { readonly ok: true; readonly words: readonly ShellWord[] }
  | { readonly ok: false; readonly refusal: ShellRefusal };

// ============================================================================
// Characters and lines
// ============================================================================

/** A word index is known, and a state counts words, up to here: no leading word of a command stands past it. */
const WORD_COUNT_CAP = 8;

const isBlank = (char: string | undefined): boolean => char === " " || char === "\t";

const SHELL_OPERATORS: ReadonlySet<string> = new Set([";", "&", "|", "<", ">", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES: ReadonlySet<string> = new Set(['"', "\\", "$", "`"]);

/** A shell name followed by `=`, as POSIX writes one: a letter or _, then letters, digits and _. */
const NAME_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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

function physicalLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 1-based line and 0-based column of an offset. */
function positionOf(text: string, offset: number): { readonly line: number; readonly column: number } {
  const before = physicalLines(text.slice(0, offset));
  return { line: before.length, column: before[before.length - 1].length };
}

// ============================================================================
// Refusal sentences
// ============================================================================

/** A refusal found while reading a line, at a column of it, until the line's number is known. */
interface LineRefusal {
  readonly code: ShellRefusalCode;
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
    `Studio runs one command and no shell, so it refuses the ${char} at line ${line}, column ${column}: ${KEEP_TEXT}.`;

const unclosedSentence = (kind: ShellQuote, line: number, column: number): string =>
  `The ${kind} quote in the word at line ${line}, column ${column} is never closed: close it before the end of the text.`;
const trailingBackslashSentence = (line: number, column: number): string =>
  `The backslash at line ${line}, column ${column} ends the text and escapes nothing, which shells read differently (bash keeps it and zsh drops it): remove it, or write it between single quotes.`;
const surrogateSentence = (line: number, column: number): string =>
  `The text holds a lone UTF-16 surrogate at line ${line}, column ${column}, which is not a character: remove it.`;
const secondCommandSentence = (line: number): string =>
  `Line ${line} holds a second command: Studio runs one command per run. Select the line to run it, and the editor sends the selection.`;

// ============================================================================
// One physical line, by the shell's quoting
// ============================================================================

/** The part of a word one physical line holds, with one mark per UTF-16 unit: "u" unquoted, "q" quoted or escaped. */
interface WordPart {
  readonly text: string;
  readonly quoting: string;
  /** A quote mark or a backslash stood in the part, an empty pair of quotes included. */
  readonly quoted: boolean;
  /** The part carries on a word a line before left open; otherwise the word starts on this line, at `column`. */
  readonly resumed: boolean;
  readonly column: number;
  /** The column just past the last source character the part took; undefined when it took none on this line. */
  readonly end?: number;
}

interface PartBuilder {
  text: string;
  quoting: string;
  quoted: boolean;
  readonly resumed: boolean;
  readonly column: number;
  end?: number;
  /** The word began on this line with an unquoted `-`, which a tokens provider draws as a flag. */
  readonly flag: boolean;
  /** The word's index among the command line's words, when it is below the cap. */
  readonly index?: number;
}

/** What a physical line leaves open for the next: a quote, a backslash-newline, a word. */
interface ShellCarry {
  readonly quote: ShellQuote;
  readonly continued: boolean;
  readonly inWord: boolean;
}

interface ShellScan {
  readonly tokens: readonly ShellToken[];
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
  readonly tokens: ShellToken[] = [];

  add(kind: ShellTokenKind, start: number, end: number, wordIndex?: number): void {
    if (end <= start) return;
    const last = this.tokens[this.tokens.length - 1];
    const token: ShellToken = wordIndex === undefined ? { kind, start, end } : { kind, start, end, wordIndex };
    if (last !== undefined && last.kind === kind && last.end === start && last.wordIndex === wordIndex) {
      this.tokens[this.tokens.length - 1] = { ...token, start: last.start };
    } else {
      this.tokens.push(token);
    }
  }
}

/** A `$` stays data only where no shell reads anything after it. */
const dollarIsData = (next: string | undefined, insideDoubleQuotes: boolean): boolean =>
  next === undefined || isBlank(next) || (insideDoubleQuotes && next === '"');

const wordPart = (builder: PartBuilder): WordPart => ({
  text: builder.text,
  quoting: builder.quoting,
  quoted: builder.quoted,
  resumed: builder.resumed,
  column: builder.column,
  ...(builder.end === undefined ? {} : { end: builder.end }),
});

/** Reads one physical line by the shell's quoting, from what the line before left open. */
function scanShellLine(line: string, carry: ShellCarry, wordsBefore: number): ShellScan {
  const sink = new TokenSink();
  const words: WordPart[] = [];
  const refusals: LineRefusal[] = [];
  const indexOf = (position: number): number | undefined => (position < WORD_COUNT_CAP ? position : undefined);
  let quote = carry.quote;
  let continued = false;
  let word: PartBuilder | undefined = carry.inWord
    ? { text: "", quoting: "", quoted: false, resumed: true, column: 0, flag: false, index: indexOf(wordsBefore) }
    : undefined;
  // A quote open across the line break keeps the break as data, unless it was a backslash-newline.
  if (word !== undefined && (quote === "single" || (quote === "double" && !carry.continued))) {
    word.text += "\n";
    word.quoting += "q";
  }

  const take = (current: PartBuilder, text: string, mark: "u" | "q", end: number): void => {
    current.text += text;
    current.quoting += mark.repeat(text.length);
    if (mark === "q") current.quoted = true;
    current.end = end;
  };
  const finish = (current: PartBuilder): void => {
    words.push(wordPart(current));
    word = undefined;
  };
  const refuse = (sentence: LineRefusal["sentence"], code: ShellRefusalCode, column: number): void => {
    refusals.push({ code, column, sentence });
  };

  let pos = 0;
  while (pos < line.length) {
    const char = line[pos];
    if (word !== undefined && quote === "single") {
      // Everything up to the next single quote is data.
      const close = line.indexOf("'", pos);
      const end = close < 0 ? line.length : close + 1;
      take(word, line.slice(pos, close < 0 ? line.length : close), "q", end);
      sink.add("string", pos, end, word.index);
      if (close >= 0) quote = "none";
      pos = end;
      continue;
    }
    if (word !== undefined && quote === "double") {
      const next = line[pos + 1];
      if (char === '"') {
        quote = "none";
        take(word, "", "q", pos + 1);
        sink.add("string", pos, pos + 1, word.index);
        pos += 1;
      } else if (char === "\\" && next === undefined) {
        // A backslash-newline inside double quotes is removed.
        continued = true;
        take(word, "", "q", pos + 1);
        sink.add("string", pos, pos + 1, word.index);
        pos += 1;
      } else if (char === "\\" && DOUBLE_QUOTE_ESCAPES.has(next)) {
        take(word, next, "q", pos + 2);
        sink.add("string", pos, pos + 2, word.index);
        pos += 2;
      } else if ((char === "$" && !dollarIsData(next, true)) || char === "`") {
        refuse(char === "$" ? DOLLAR : BACKQUOTE, "shell-expansion", pos);
        take(word, char, "q", pos + 1);
        sink.add("invalid", pos, pos + 1, word.index);
        pos += 1;
      } else {
        // Every other backslash inside double quotes is data.
        take(word, char, "q", pos + 1);
        sink.add("string", pos, pos + 1, word.index);
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
        sink.add(word.flag ? "flag" : "word", pos, pos + 1, word.index);
      }
      pos += 1;
      continue;
    }
    const current: PartBuilder = word ?? {
      text: "",
      quoting: "",
      quoted: false,
      resumed: false,
      column: pos,
      flag: char === "-",
      index: indexOf(wordsBefore + words.length),
    };
    word = current;
    const kind: ShellTokenKind = current.flag ? "flag" : "word";
    if (char === "\\") {
      take(current, line[pos + 1], "q", pos + 2);
      sink.add(kind, pos, pos + 2, current.index);
      pos += 2;
    } else if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      take(current, "", "q", pos + 1);
      sink.add("string", pos, pos + 1, current.index);
      pos += 1;
    } else if ((char === "$" && !dollarIsData(line[pos + 1], false)) || char === "`") {
      refuse(char === "$" ? DOLLAR : BACKQUOTE, "shell-expansion", pos);
      take(current, char, "u", pos + 1);
      sink.add("invalid", pos, pos + 1, current.index);
      pos += 1;
    } else {
      take(current, char, "u", pos + 1);
      sink.add(kind, pos, pos + 1, current.index);
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

// ============================================================================
// One line in its section
// ============================================================================

interface LineReading {
  readonly tokens: readonly ShellToken[];
  readonly state: ShellLineState;
  readonly words: readonly WordPart[];
  readonly open?: WordPart;
  readonly refusals: readonly LineRefusal[];
  /** A line past the command line that is neither blank nor a comment: where its content starts. */
  readonly content?: number;
}

/** A line past the command line: blank, a comment, or content, which is a second command. */
function readAfterLine(line: string, state: ShellLineState): LineReading {
  const sink = new TokenSink();
  let start = 0;
  while (isBlank(line[start])) start += 1;
  sink.add("whitespace", 0, start);
  if (start === line.length) return { tokens: sink.tokens, state, words: [], refusals: [] };
  if (line[start] === "#") {
    sink.add("comment", start, line.length);
    return { tokens: sink.tokens, state, words: [], refusals: [] };
  }
  sink.add("invalid", start, line.length);
  return { tokens: sink.tokens, state, words: [], refusals: [], content: start };
}

function readLine(line: string, state: ShellLineState): LineReading {
  if (state.section === "after") return readAfterLine(line, state);
  const scan = scanShellLine(line, state, state.wordsBefore);
  const finished = Math.min(WORD_COUNT_CAP, state.wordsBefore + scan.words.length);
  let next: ShellLineState;
  if (scan.carry.quote !== "none" || scan.carry.continued) {
    next = { section: "command", ...scan.carry, wordsBefore: finished };
  } else if (finished === 0) {
    // Nothing but blanks and a comment so far: the command line is still to come.
    next = INITIAL_SHELL_LINE_STATE;
  } else {
    next = { ...INITIAL_SHELL_LINE_STATE, section: "after" };
  }
  return { tokens: scan.tokens, state: next, words: scan.words, open: scan.open, refusals: scan.refusals };
}

/** One physical line, from the state the line before left; what the editor's tokens provider calls. */
export function tokenizeShellLine(
  line: string,
  state: ShellLineState,
): { readonly tokens: readonly ShellToken[]; readonly state: ShellLineState } {
  const reading = readLine(line, state);
  return { tokens: reading.tokens, state: reading.state };
}

// ============================================================================
// The whole text, line by line
// ============================================================================

/** A word read whole, across as many lines as it runs over, with its quoting marks. */
interface JoinedWord extends ShellWord {
  readonly quoting: string;
}

/** `part` added to the word a line before left open, or a word of its own when it starts on `line`. */
function joinPart(open: JoinedWord | undefined, part: WordPart, line: number): JoinedWord {
  // A part that starts its word took its first character, so it has an end.
  if (!part.resumed) {
    const end = part.end as number;
    return {
      text: part.text,
      quoting: part.quoting,
      quoted: part.quoted,
      line,
      column: part.column,
      endLine: line,
      endColumn: end,
    };
  }
  // A line resumes a word only when the line before left one open.
  const word = open as JoinedWord;
  return {
    ...word,
    text: word.text + part.text,
    quoting: word.quoting + part.quoting,
    quoted: word.quoted || part.quoted,
    ...(part.end === undefined ? {} : { endLine: line, endColumn: part.end }),
  };
}

const isUnquoted = (quoting: string, from: number, to: number): boolean => !quoting.slice(from, to).includes("q");

/**
 * Braces a shell may expand: an unquoted pair holding, at its own level, an unquoted comma or a `..` quoted or not,
 * because zsh expands a sequence whatever the quoting of its dots (measured: zsh 5.9 read {1.'.'3}, {1'..'3} and
 * {1\..3} as 1, 2 and 3, where bash 5.2.21 kept them as written).
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

/** The refusals only a whole word shows, at its first character. */
function wordRefusals(word: JoinedWord): ShellRefusal[] {
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

const earliest = (refusals: readonly ShellRefusal[]): ShellRefusal =>
  refusals.reduce((first, next) =>
    next.line < first.line || (next.line === first.line && next.column < first.column) ? next : first,
  );

/** What a text still holds open when it ends: a quote, or a backslash-newline with no next line. */
function openAtEnd(
  state: ShellLineState,
  open: JoinedWord | undefined,
  lastText: string,
  lastLine: number,
): ShellRefusal | undefined {
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

/**
 * The text's one command line as words. A lone surrogate anywhere refuses the text first; otherwise the earliest
 * refusal in the text is the one reported.
 */
export function readShellCommand(text: string): ShellReading {
  const surrogate = loneSurrogateAt(text);
  if (surrogate >= 0) {
    const { line, column } = positionOf(text, surrogate);
    return { ok: false, refusal: { code: "not-text", line, column, message: surrogateSentence(line, column + 1) } };
  }
  const lines = physicalLines(text);
  const words: ShellWord[] = [];
  const refusals: ShellRefusal[] = [];
  let open: JoinedWord | undefined;
  let state = INITIAL_SHELL_LINE_STATE;
  lines.forEach((lineText, index) => {
    const line = index + 1;
    const reading = readLine(lineText, state);
    for (const refusal of reading.refusals) {
      refusals.push({
        code: refusal.code,
        line,
        column: refusal.column,
        message: refusal.sentence(line, refusal.column + 1),
      });
    }
    for (const part of reading.words) {
      const { quoting, ...word } = joinPart(open, part, line);
      refusals.push(...wordRefusals({ ...word, quoting }));
      words.push(word);
    }
    open = reading.open === undefined ? undefined : joinPart(open, reading.open, line);
    if (reading.content !== undefined) {
      refusals.push({
        code: "second-command",
        line,
        column: reading.content,
        message: secondCommandSentence(line),
      });
    }
    state = reading.state;
  });
  const unclosed = openAtEnd(state, open, lines[lines.length - 1], lines.length);
  if (unclosed !== undefined) refusals.push(unclosed);
  if (refusals.length > 0) return { ok: false, refusal: earliest(refusals) };
  return { ok: true, words };
}

// ============================================================================
// Quoting
// ============================================================================

const BARE_ASCII: ReadonlySet<string> = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./:@%+=,^",
);

/** A character past ASCII that shows as itself: a letter, a mark, a number, punctuation or a symbol. */
const PRINTED = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;

/**
 * A word that reads back as itself here and in a shell, so it needs no quotes. Conservative on purpose: glob
 * characters, which the reader keeps as data, are quoted too, so a generated command also pastes into a shell as
 * written, and so is every invisible or reordering character past ASCII. A word that begins with `=` is quoted,
 * because zsh expands one that holds more than the `=`.
 */
function isBare(text: string): boolean {
  if (text === "" || text.startsWith("=")) return false;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80 ? !BARE_ASCII.has(char) : !PRINTED.test(char)) return false;
  }
  return true;
}

/**
 * A word that reads back as itself in this reader and in bash, dash and zsh: bare when it is safe text, else
 * between single quotes with `'\''` for each single quote. A word that begins with `-` is left as it is; the caller
 * writes it after `--`. Throws for a CR, a U+0000 or a lone surrogate, none of which has a spelling here.
 */
export function quoteShellWord(text: string): string {
  if (text.includes("\r"))
    throw new Error("A carriage return has no spelling on a command line, where the editor ends a line at it");
  if (text.includes("\u0000"))
    throw new Error("A NUL character has no spelling on a command line: a shell ends a word at it");
  if (loneSurrogateAt(text) >= 0) throw new Error("A lone UTF-16 surrogate is not text, so no quoting reads it back");
  if (isBare(text)) return text;
  return `'${text.split("'").join("'\\''")}'`;
}
