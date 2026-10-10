/**
 * Query history's copy of a statement, with the value of every credential flag its dialect declares replaced.
 *
 * History stores what the user ran, refused statements included, and a console that refuses a credential flag
 * still meets one pasted from a shell. So the text is masked before it is stored, on the raw text: a statement
 * that reads as one command line has each declared flag's value replaced, in the `--flag=value` and
 * `--flag value` forms and quoted or not, and each of its comments is cut from its first declared flag to the end
 * of its line; a text that does not read as one command line is cut from its first declared flag to the end of
 * that line, and further when the cut part opens a quote or continues the line.
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
 * A declared flag where it stands as a flag: not preceded by a character a flag name holds, so a flag glued to a
 * shell operator (`|--token`, `$(--token`) is found, and not followed by one, so `--tokenfile` is not.
 */
function flagPattern(flags: readonly string[]): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_-])(?:${flags.map(escapeForPattern).join("|")})(?=$|[^A-Za-z0-9_-])`);
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
 */
function maskWords(text: string, words: readonly ShellWord[], flags: readonly string[]): string {
  const starts = lineStarts(text);
  const offset = (line: number, column: number): number => starts[line - 1] + column;
  // Keyed by the start of the replaced span: `--token --token=x` names its second word twice, and spans never overlap.
  const cuts = new Map<number, { readonly end: number; readonly text: string }>();
  words.forEach((word, index) => {
    const flag = flags.find((candidate) => word.text === candidate || word.text.startsWith(`${candidate}=`));
    if (flag === undefined) return;
    const target = word.text === flag ? words[index + 1] : word;
    if (target === undefined || cuts.has(offset(target.line, target.column))) return;
    cuts.set(offset(target.line, target.column), {
      end: offset(target.endLine, target.endColumn),
      text: target === word ? `${flag}=${MASK}` : MASK,
    });
  });
  const flag = flagPattern(flags);
  for (const comment of commentSpans(text, starts)) {
    const found = flag.exec(text.slice(comment.start, comment.end));
    if (found === null) continue;
    cuts.set(comment.start + found.index + found[0].length, { end: comment.end, text: ` ${MASK}` });
  }
  let masked = text;
  for (const [start, cut] of [...cuts.entries()].sort(([left], [right]) => right - left)) {
    masked = `${masked.slice(0, start)}${cut.text}${masked.slice(cut.end)}`;
  }
  return masked;
}

const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A text the shell reader refuses, masked line by line from the first declared flag on each line.
 *
 * A cut part that opens a quote it does not close, or ends in a backslash, carries the value on to a later line,
 * and the reader that refused the text cannot say where it ends, so everything after the flag is dropped.
 */
function maskLines(text: string, flags: readonly string[]): string {
  const flag = flagPattern(flags);
  // Lines at even indexes, their endings at odd ones, so joining restores every ending that is kept.
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let index = 0; index < parts.length; index += 2) {
    const found = flag.exec(parts[index]);
    if (found === null) continue;
    const cut = found.index + found[0].length;
    const rest = parts[index].slice(cut);
    parts[index] = `${parts[index].slice(0, cut)} ${MASK}`;
    if (runsOn(rest)) return parts.slice(0, index + 1).join("");
  }
  return parts.join("");
}

/** Whether a cut part leaves a quote open or ends in a backslash that joins the next line. */
function runsOn(rest: string): boolean {
  const count = (char: string): number => rest.split(char).length - 1;
  return count("'") % 2 === 1 || count('"') % 2 === 1 || /(^|[^\\])(\\\\)*\\$/.test(rest);
}
