/**
 * The kubectl console text, read as words: one kubectl command, written as a shell would pass it to kubectl.
 *
 * Pure, and shipped to the browser. The words are the shared shell-word reader's
 * (`src/lib/db/console/shell-words.ts`): its quoting, its refusals and its one-command rule, so a `#` line is a
 * comment and a second command line is refused. This module adds what is kubectl's: the words a pasted line
 * carries before the command (a `$` or `%` prompt, then `kubectl`), and the role each token takes in the editor.
 * `tokenizeKubectlLine` reads one physical line from the shared reader's state, which is what the tokens provider
 * calls, and `kubectlWords` reads the whole text, which is what the parser calls.
 *
 * The line-by-line reading names a lead word and the command only on the line the command begins on, as the Oxia
 * lexer does: the editor's per-line state counts the words before a line and does not hold their text.
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

export type KubectlTokenRole = "lead" | "verb" | "flag" | "word" | "string" | "comment" | "whitespace" | "invalid";

export interface KubectlToken {
  readonly role: KubectlTokenRole;
  readonly start: number;
  readonly end: number;
}

/** The shared reader's initial state: the kubectl lexer keeps no state of its own. */
export const INITIAL_KUBECTL_LEX_STATE: ShellLineState = INITIAL_SHELL_LINE_STATE;

/** The prompts a pasted line is printed after. */
export const KUBECTL_PROMPTS: ReadonlySet<string> = new Set(["$", "%"]);

/** The program name a pasted line starts with. */
const KUBECTL_PROGRAM = "kubectl";

/**
 * kubectl's global flags that take a value, in every spelling. Written before the command without `=`, each takes the
 * next word, which is therefore not the command. `commandWordIndex` reads this set for the parser and the editor
 * alike, so they cannot disagree on which word is the command.
 */
export const KUBECTL_VALUE_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-n",
  "--namespace",
  "-s",
  "--server",
  "--context",
  "--cluster",
  "--user",
  "--token",
  "--kubeconfig",
  "--as",
  "--as-group",
  "--as-uid",
  "--as-user-extra",
  "--username",
  "--password",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--tls-server-name",
  "--cache-dir",
  "--kuberc",
  "--request-timeout",
  "-v",
  "--v",
]);

/** Whether a word is a flag as kubectl reads it: its text starts with a dash, quoted or not, and is not a lone dash. */
export function isKubectlFlagText(text: string): boolean {
  return text.startsWith("-") && text !== "-";
}

/**
 * The index of the command among the words after the lead, from each word's text as the shell passes it: the first
 * word that is neither a flag nor the value a global flag takes, or the word after `--`. A word whose text is not
 * known (undefined) ends the search unless it is a flag's value. The parser and the editor both call this; the
 * parser also finds a subcommand with it, passing the flags whose value may come before that subcommand.
 */
export function commandWordIndex(
  texts: readonly (string | undefined)[],
  valueFlags: ReadonlySet<string> = KUBECTL_VALUE_GLOBAL_FLAGS,
): number | undefined {
  let valueNext = false;
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (text === undefined) return undefined;
    if (text === "--") return texts[index + 1] === undefined ? undefined : index + 1;
    if (!isKubectlFlagText(text)) return index;
    valueNext = !text.includes("=") && valueFlags.has(text);
  }
  return undefined;
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

/**
 * A word's text when all of it is one unquoted, unescaped token, which is what a lead word or a flag name is;
 * undefined for a word that holds a quote, an escape or a refused character.
 */
function plainText(line: string, word: LineWord): string | undefined {
  if (word.tokens.length !== 1) return undefined;
  const [token] = word.tokens;
  if (token.kind !== "word" && token.kind !== "flag") return undefined;
  const text = line.slice(token.start, token.end);
  return text.includes("\\") ? undefined : text;
}

/**
 * A whole word's text as the shell passes it on (quotes and escapes taken off), read by the shared reader; undefined
 * when the reader refuses it.
 */
function shellText(line: string, word: LineWord): string | undefined {
  const reading = readShellCommand(line.slice(word.tokens[0].start, word.tokens[word.tokens.length - 1].end));
  return reading.ok && reading.words.length === 1 ? reading.words[0].text : undefined;
}

/** Which of the line's words are lead words and which one is the command, by word index. */
function leadAndVerb(
  line: string,
  words: readonly LineWord[],
  openIndex: number | undefined,
): ReadonlyMap<number, "lead" | "verb"> {
  const roles = new Map<number, "lead" | "verb">();
  let at = 0;
  const plain = (): string | undefined =>
    at < words.length && words[at].index !== openIndex ? plainText(line, words[at]) : undefined;
  const prompt = plain();
  if (prompt !== undefined && KUBECTL_PROMPTS.has(prompt)) {
    roles.set(words[at].index, "lead");
    at += 1;
  }
  if (plain() === KUBECTL_PROGRAM) {
    roles.set(words[at].index, "lead");
    at += 1;
  }
  // The command is found by the parser's own rule on each word's shell text, so a quoted "-n" is a flag here as it
  // is there. A word that runs on past this line is not read whole here, so it decides nothing.
  const rest = words.slice(at);
  const open = rest.findIndex((word) => word.index === openIndex);
  const whole = open === -1 ? rest : rest.slice(0, open);
  const verb = commandWordIndex(whole.map((word) => shellText(line, word)));
  if (verb !== undefined) roles.set(whole[verb].index, "verb");
  return roles;
}

/** One physical line as the editor draws it, from the state the line before left. */
export function tokenizeKubectlLine(
  line: string,
  state: ShellLineState,
): { readonly tokens: readonly KubectlToken[]; readonly state: ShellLineState } {
  const reading = tokenizeShellLine(line, state);
  // Only the line the command line begins on is read for its lead and its command.
  const begins = state.section !== "after" && state.wordsBefore === 0 && !state.inWord;
  const words = begins ? indexedWords(reading.tokens) : [];
  const openIndex = reading.state.inWord ? reading.state.wordsBefore : undefined;
  const roles = leadAndVerb(line, words, openIndex);
  const tokens = reading.tokens.map((token): KubectlToken => {
    const role = token.wordIndex === undefined ? undefined : roles.get(token.wordIndex);
    if (role === "lead") return { role: "lead", start: token.start, end: token.end };
    if (role === "verb" && token.kind === "word") return { role: "verb", start: token.start, end: token.end };
    return { role: token.kind, start: token.start, end: token.end };
  });
  return { tokens, state: reading.state };
}

const isBareWord = (word: ShellWord | undefined, text: string): boolean =>
  word !== undefined && !word.quoted && word.text === text;

/** The command line's words with the lead stripped: one prompt, then `kubectl`. */
export function kubectlWords(
  text: string,
):
  | { readonly ok: true; readonly lead: readonly ShellWord[]; readonly words: readonly ShellWord[] }
  | { readonly ok: false; readonly refusal: ShellRefusal } {
  const reading = readShellCommand(text);
  if (!reading.ok) return reading;
  const all = reading.words;
  let at = 0;
  if (at < all.length && !all[at].quoted && KUBECTL_PROMPTS.has(all[at].text)) at += 1;
  if (isBareWord(all[at], KUBECTL_PROGRAM)) at += 1;
  return { ok: true, lead: all.slice(0, at), words: all.slice(at) };
}
