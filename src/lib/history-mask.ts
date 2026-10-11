/**
 * Query history's copy of a statement, with the value of every credential flag its dialect declares replaced.
 *
 * History stores what the user ran, refused statements included, and a console that refuses a credential flag
 * still meets one pasted from a shell. So the text is masked before it is stored, on the raw text: a statement
 * that reads as one command line has each declared flag's value replaced, in the `--flag=value` and
 * `--flag value` forms, quoted or not and in any letter case, and also where a word runs on from the flag past a
 * character no flag name holds; each of its comments is cut from its first declared flag to the end of its line.
 * A text that does not read as one command line is cut from its first declared flag to the end of that line, and
 * further when the line leaves a quote open or continues.
 *
 * A flag a paste from rich text hides from the shell reader is still found. It is found anywhere in a word, a
 * comment or a line where no ASCII letter, digit, `_` or `-` stands right before or after it, not only where a word
 * starts: after a no-break space, a form feed, a zero-width character, a quote, a dash, a comma or a continuation,
 * and inside a quoted value or an error's text. A letter outside ASCII right before or after it does not hide it,
 * a long s (U+017F) or a Kelvin sign (U+212A) included, though case folding maps them onto s and k. Its name is
 * found with quotes, backslashes or zero-width characters inside it, and with dashes or minus signs written for the
 * two hyphens it starts with. A flag followed in its word by nothing but `=`, `:`, white space, quotes, backslashes
 * or zero-width characters has the next word replaced as its value.
 *
 * Not masked: a flag spelled any other way, such as with a dash for a hyphen inside its name, or with a letter
 * outside ASCII for one of its letters, a Kelvin sign for a k or a long s for an s included; a value written before
 * the flag that names it, as an error can quote one; and a value on a later line than its flag that no continuation
 * or open quote carries there.
 *
 * A history entry's error text is stored through the same mask, since an error can repeat the statement it refuses.
 *
 * Only history is masked. The tab keeps what the user typed, a saved query keeps what the user saved, and the
 * embedded workspace writes no history of its own.
 */
import {
  INITIAL_SHELL_LINE_STATE,
  readShellCommand,
  type ShellWord,
  tokenizeShellLine,
} from "@/lib/db/console/shell-words";
import { type DialectSpec, QUERY_DIALECTS, type QueryDialect, registeredDialect } from "@/lib/db/query-dialects";
import type { ProviderCapabilities } from "@/lib/db/types";

const MASK = "***";

/**
 * The mask a connection's statements are stored under.
 *
 * Unknown capabilities, the window before a connection's metadata has loaded, take every dialect's flags at once:
 * which dialect the statement is in is not known yet, and a credential stored in that window would stay in
 * history. The cost is that a statement of another engine run in that window, holding a declared flag followed by
 * a value, is stored with that value masked too; history then holds less than was typed, never a credential.
 * A declared language with no registered dialect, which is every SQL engine, has no mask.
 */
export function historyMaskOf(
  capabilities: ProviderCapabilities | undefined,
  dialects: Readonly<Record<QueryDialect, DialectSpec>> = QUERY_DIALECTS,
): { readonly credentialFlags: readonly string[] } | undefined {
  if (capabilities === undefined) {
    const flags = new Set(Object.values(dialects).flatMap((spec) => spec.historyMask?.credentialFlags ?? []));
    return flags.size === 0 ? undefined : { credentialFlags: [...flags] };
  }
  const dialect = registeredDialect(capabilities);
  return dialect === undefined ? undefined : dialects[dialect].historyMask;
}

export function maskStatementForHistory(
  text: string,
  mask: { readonly credentialFlags: readonly string[] } | undefined,
): string {
  const flags = mask?.credentialFlags ?? [];
  if (flags.length === 0) return text;
  const reading = readShellCommand(text);
  return reading.ok ? maskWords(text, reading.words, flags) : maskLines(text, flags);
}

/**
 * What may stand inside a flag's name: a quote or a backslash, which the shell joins a word across, and a character
 * a renderer may draw as nothing, such as a zero-width space or joiner, a soft hyphen or a byte order mark.
 */
const INSIDE_NAME = /["'\\\p{Default_Ignorable_Code_Point}]/u;

/**
 * A declared flag where it stands as a flag: not preceded by a character a flag name holds, so a flag glued to a
 * shell operator (`|--token`, `$(--token`) is found, and not followed by one, so `--tokenfile` is not.
 * Letter case is ignored: a console refuses `--TOKEN` as an unknown flag, and history still stores it. Each ASCII
 * letter of the name is matched in either case by a class of its own rather than by the `i` flag: under the `u` flag
 * `INSIDE_NAME` needs, `i` folds a long s (U+017F) onto s and a Kelvin sign (U+212A) onto k, so the classes around
 * the name would take either for a character a flag name holds and leave a flag right next to one unfound.
 * `INSIDE_NAME` characters may stand between the name's characters, and at either end they part the flag from the
 * text around it, so `--to"ken"` and `--token""value` are both found; more hyphens may lead it, since a dash is
 * read as two. `after` narrows what may follow it.
 */
function flagPattern(flags: readonly string[], after = "(?=$|[^A-Za-z0-9_-])"): RegExp {
  const names = flags.map((flag) => [...flag].map(eitherCase).join(`${INSIDE_NAME.source}*`));
  return new RegExp(`(?<![A-Za-z0-9_-])-*(?:${names.join("|")})${after}`, "gu");
}

/** A character of a flag name as a pattern: an ASCII letter in either case, any other character as written. */
function eitherCase(char: string): string {
  return /^[A-Za-z]$/.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escapeForPattern(char);
}

/** A declared flag at the start of a word's text, followed by anything a flag name does not hold. */
function leadingFlagPattern(flags: readonly string[]): RegExp {
  return new RegExp(`^(?:${flags.map(escapeForPattern).join("|")})(?=$|[^A-Za-z0-9_-])`, "i");
}

const QUOTING = /["'\\]/;
/** A dash a word processor or a keyboard put where a flag's hyphens stood, read as the two hyphens. */
const DASH = /^[\p{Pd}\u2212]$/u;
/** A character a word may hold after a flag and still leave the flag's value to the next word. */
const NO_VALUE_CHARACTER = /[=:\s"'\\\p{Default_Ignorable_Code_Point}]/u;
const NO_VALUE = new RegExp(`^${NO_VALUE_CHARACTER.source}*$`, "u");

/**
 * Where each declared flag in a source ends, in order, past any quotes or backslashes that close it. The source is
 * read as written, and again with each dash other than `-` read as `--`: a dash can stand for a flag's two hyphens,
 * and it can also part a flag from the text around it, as it does where it is read as written. A flag that starts
 * inside another one's match is found too.
 */
function flagEnds(source: string, flag: RegExp): number[] {
  // `dashedEnds[i]` is the source offset just past the character the dashed reading's i-th unit was read from.
  const dashedEnds: number[] = [];
  const reads: string[] = [];
  let offset = 0;
  for (const char of source) {
    offset += char.length;
    const read = char !== "-" && DASH.test(char) ? "--" : char;
    for (let unit = 0; unit < read.length; unit++) dashedEnds.push(offset);
    reads.push(read);
  }
  const ends = new Set<number>();
  const collect = (reading: string, endOf: (match: RegExpExecArray) => number): void => {
    flag.lastIndex = 0;
    for (let match = flag.exec(reading); match !== null; match = flag.exec(reading)) {
      let end = endOf(match);
      while (end < source.length && QUOTING.test(source[end])) end += 1;
      ends.add(end);
      flag.lastIndex = match.index + 1;
    }
  };
  collect(source, (match) => match.index + match[0].length);
  collect(reads.join(""), (match) => dashedEnds[match.index + match[0].length - 1]);
  return [...ends].sort((left, right) => left - right);
}

/** Where a source's first declared flag ends, as `flagEnds` finds it; undefined when the source holds none. */
function flagEndIn(source: string, flag: RegExp): number | undefined {
  const ends = flagEnds(source, flag);
  return ends.length === 0 ? undefined : ends[0];
}

/** The offset each physical line starts at, with lines ended as the shell reader ends them: CRLF, CR or LF. */
function lineStarts(text: string): readonly number[] {
  const starts = [0];
  for (const ending of text.matchAll(/\r\n|\r|\n/g)) starts.push(ending.index + ending[0].length);
  return starts;
}

/** Each comment's offsets in the text, read line by line from the state the shell reader leaves. */
function commentSpans(text: string, starts: readonly number[]): readonly { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  let state = INITIAL_SHELL_LINE_STATE;
  lines.forEach((line, index) => {
    const reading = tokenizeShellLine(line, state);
    for (const token of reading.tokens) {
      if (token.kind === "comment") spans.push({ start: starts[index] + token.start, end: starts[index] + token.end });
    }
    state = reading.state;
  });
  return spans;
}

/**
 * Each declared flag's value replaced, located by the words the shell reader found, and each comment cut from its
 * first declared flag: the reader drops comments, and a commented line of a pasted script is still stored.
 *
 * A word that is not exactly a flag or `flag=value` still holds one when it starts with a flag followed by a
 * character no flag name holds (a no-break space, a colon, a quoted space), or when its source holds one further
 * on (after a continuation, a no-break space, a zero-width character, a comma or a quote); the rest of that word is
 * replaced. When nothing but `NO_VALUE` characters follow the flag in its word, the next word is replaced instead.
 * A word that ends with a flag, or with one that only `NO_VALUE` characters follow, has the next word replaced too,
 * though an earlier flag in the word, joined to it by a continuation, has a value of its own.
 */
function maskWords(text: string, words: readonly ShellWord[], flags: readonly string[]): string {
  const starts = lineStarts(text);
  const offset = (line: number, column: number): number => starts[line - 1] + column;
  // Keyed by the start of the replaced span: `--token --token=x` names its second word twice. A span can also hold
  // another, when a word replaced as a value holds a flag of its own; the two are joined before they are applied.
  const cuts = new Map<number, { readonly end: number; readonly text: string }>();
  const cut = (start: number, end: number, replacement: string): void => {
    if (!cuts.has(start)) cuts.set(start, { end, text: replacement });
  };
  const maskWord = (word: ShellWord | undefined): void => {
    if (word !== undefined) cut(offset(word.line, word.column), offset(word.endLine, word.endColumn), MASK);
  };
  const leading = leadingFlagPattern(flags);
  const anywhere = flagPattern(flags);
  const ending = flagPattern(flags, `(?=${NO_VALUE_CHARACTER.source}*$)`);
  words.forEach((word, index) => {
    const start = offset(word.line, word.column);
    const end = offset(word.endLine, word.endColumn);
    if (flagEndIn(text.slice(start, end), ending) !== undefined) maskWord(words[index + 1]);
    const flag = flags.find((candidate) => word.text === candidate || word.text.startsWith(`${candidate}=`));
    if (flag !== undefined) {
      if (NO_VALUE.test(word.text.slice(flag.length))) maskWord(words[index + 1]);
      else cut(start, end, `${flag}=${MASK}`);
      return;
    }
    const lead = leading.exec(word.text);
    if (lead !== null) {
      if (NO_VALUE.test(word.text.slice(lead[0].length))) maskWord(words[index + 1]);
      else cut(start, end, `${lead[0]} ${MASK}`);
      return;
    }
    const found = flagEndIn(text.slice(start, end), anywhere);
    if (found === undefined) return;
    if (NO_VALUE.test(text.slice(start + found, end))) maskWord(words[index + 1]);
    else cut(start + found, end, ` ${MASK}`);
  });
  for (const comment of commentSpans(text, starts)) {
    const found = flagEndIn(text.slice(comment.start, comment.end), anywhere);
    if (found === undefined) continue;
    cuts.set(comment.start + found, { end: comment.end, text: ` ${MASK}` });
  }
  // Applied in one pass from the start: a cut that starts inside the span before it is joined to that span, so no
  // replacement lands on offsets another one has shifted.
  const pieces: string[] = [];
  let kept = 0;
  for (const [start, replaced] of [...cuts.entries()].sort(([left], [right]) => left - right)) {
    if (start < kept) {
      kept = Math.max(kept, replaced.end);
      continue;
    }
    pieces.push(text.slice(kept, start), replaced.text);
    kept = replaced.end;
  }
  pieces.push(text.slice(kept));
  return pieces.join("");
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A text the shell reader refuses, masked line by line from the first declared flag on each line.
 *
 * A flag name the shell would join from quoted or escaped parts (`--to"ken"`, `--to\ken`) is found too, since
 * quotes and backslashes may stand inside a name.
 * A line that leaves a quote open or continues, as the shell reader reads it from the lines before, or one where the
 * part after any of its flags opens a quote it does not close or ends in a backslash, carries a value on to a later
 * line, and the reader that refused the text cannot say where it ends, so everything after the first flag is dropped.
 */
function maskLines(text: string, flags: readonly string[]): string {
  const flag = flagPattern(flags);
  // Lines at even indexes, their endings at odd ones, so joining restores every ending that is kept.
  const parts = text.split(/(\r\n|\r|\n)/);
  let state = INITIAL_SHELL_LINE_STATE;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    // A line past the command line is read as a command of its own, so its quotes are followed too.
    const reading = tokenizeShellLine(line, state.section === "after" ? INITIAL_SHELL_LINE_STATE : state);
    state = reading.state;
    const ends = flagEnds(line, flag);
    if (ends.length === 0) continue;
    parts[index] = `${line.slice(0, ends[0])} ${MASK}`;
    if (runsOn(line, ends) || state.quote !== "none" || state.continued) return parts.slice(0, index + 1).join("");
  }
  return parts.join("");
}

/**
 * Whether the part of a line after one of its flags' `ends` opens a quote it does not close, or the part after the
 * first ends in a backslash that joins the next line. Each quote is counted once, walking back from the line's end.
 */
function runsOn(line: string, ends: readonly number[]): boolean {
  if (/(^|[^\\])(\\\\)*\\$/.test(line.slice(ends[0]))) return true;
  const after = new Set(ends);
  let single = false;
  let double = false;
  for (let index = line.length; index >= ends[0]; index--) {
    if (after.has(index) && (single || double)) return true;
    if (line[index - 1] === "'") single = !single;
    else if (line[index - 1] === '"') double = !double;
  }
  return false;
}
