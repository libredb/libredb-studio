/**
 * The Oxia editor text, read as words: one `oxia client` read command, written as the CLI writes it.
 *
 * Pure, and shipped to the browser. The words are the shared shell-word reader's
 * (`src/lib/db/console/shell-words.ts`): its quoting, its refusals and its one-command rule. This module adds what
 * is Oxia's: the words a documented command line carries before its verb (a prompt, `oxia`, `client`), and the role
 * each token takes in the editor. `tokenizeOxiaLine` reads one physical line from the shared reader's state, which
 * is what the tokens provider calls, and `oxiaWords` reads the whole text, which is what the parser calls.
 *
 * The line-by-line reading names a lead word and the verb only on the line the command begins on: the state the
 * editor keeps per line is the shared reader's, which counts the words before a line and does not hold their
 * text, so a lead or a verb that a backslash-newline pushed to a later line is drawn as a plain word. The parser
 * reads the whole text and is not limited that way.
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

export type OxiaTokenRole = "lead" | "verb" | "flag" | "word" | "string" | "comment" | "whitespace" | "invalid";

export interface OxiaToken {
  readonly role: OxiaTokenRole;
  readonly start: number;
  readonly end: number;
}

/** The shared reader's initial state: the Oxia lexer keeps no state of its own. */
export const INITIAL_OXIA_LEX_STATE: ShellLineState = INITIAL_SHELL_LINE_STATE;

/** The prompts a docs line is printed after. */
export const OXIA_PROMPTS: ReadonlySet<string> = new Set(["$", "%"]);

/**
 * The CLI's persistent flags that take a value, in both spellings. Written before the verb without `=`, each takes
 * the next word, which is therefore not the verb. The parser reads the same set, so the two cannot disagree.
 */
export const OXIA_VALUE_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "-a",
  "--service-address",
  "-n",
  "--namespace",
  "--request-timeout",
  "--auth-token",
  "--auth-token-file",
]);

const LEAD_COMMAND = "oxia";
const LEAD_SUBCOMMAND = "client";

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

/** Which of the line's words are lead words and which one is the verb, by word index. */
function leadAndVerb(
  line: string,
  words: readonly LineWord[],
  openIndex: number | undefined,
): ReadonlyMap<number, "lead" | "verb"> {
  const roles = new Map<number, "lead" | "verb">();
  let at = 0;
  const plain = (): string | undefined =>
    at < words.length && words[at].index !== openIndex ? plainText(line, words[at]) : undefined;
  const takeLead = (): void => {
    roles.set(words[at].index, "lead");
    at += 1;
  };
  const prompt = plain();
  if (prompt !== undefined && OXIA_PROMPTS.has(prompt)) takeLead();
  if (plain() === LEAD_COMMAND) {
    takeLead();
    if (plain() === LEAD_SUBCOMMAND) takeLead();
  }
  // The verb is the first word that is neither a flag nor the value a persistent flag takes.
  let valueNext = false;
  for (; at < words.length; at++) {
    const word = words[at];
    // A word that runs on past this line is not read whole here, so it decides nothing.
    if (word.index === openIndex) break;
    if (valueNext) {
      valueNext = false;
    } else if (word.tokens[0].kind === "flag") {
      valueNext = OXIA_VALUE_GLOBAL_FLAGS.has(plainText(line, word) ?? "");
    } else {
      roles.set(word.index, "verb");
      break;
    }
  }
  return roles;
}

/** One physical line as the editor draws it, from the state the line before left. */
export function tokenizeOxiaLine(
  line: string,
  state: ShellLineState,
): { readonly tokens: readonly OxiaToken[]; readonly state: ShellLineState } {
  const reading = tokenizeShellLine(line, state);
  // Only the line the command line begins on is read for its lead and its verb.
  const begins = state.section !== "after" && state.wordsBefore === 0 && !state.inWord;
  const words = begins ? indexedWords(reading.tokens) : [];
  const openIndex = reading.state.inWord ? reading.state.wordsBefore : undefined;
  const roles = leadAndVerb(line, words, openIndex);
  const tokens = reading.tokens.map((token): OxiaToken => {
    const role = token.wordIndex === undefined ? undefined : roles.get(token.wordIndex);
    if (role === "lead") return { role: "lead", start: token.start, end: token.end };
    if (role === "verb" && token.kind === "word") return { role: "verb", start: token.start, end: token.end };
    return { role: token.kind, start: token.start, end: token.end };
  });
  return { tokens, state: reading.state };
}

const isBareWord = (word: ShellWord | undefined, text: string): boolean =>
  word !== undefined && !word.quoted && word.text === text;

/** The command line's words with the lead stripped: one prompt, `oxia`, then `client` when `oxia` was there. */
export function oxiaWords(text: string):
  | {
      readonly ok: true;
      readonly lead: readonly ShellWord[];
      readonly words: readonly ShellWord[];
    }
  | { readonly ok: false; readonly refusal: ShellRefusal } {
  const reading = readShellCommand(text);
  if (!reading.ok) return reading;
  const all = reading.words;
  let at = 0;
  if (at < all.length && !all[at].quoted && OXIA_PROMPTS.has(all[at].text)) at += 1;
  if (isBareWord(all[at], LEAD_COMMAND)) {
    at += 1;
    if (isBareWord(all[at], LEAD_SUBCOMMAND)) at += 1;
  }
  return { ok: true, lead: all.slice(0, at), words: all.slice(at) };
}
