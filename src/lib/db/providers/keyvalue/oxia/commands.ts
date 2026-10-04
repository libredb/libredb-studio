/**
 * The Oxia command table and its parser: one `oxia client` read, as text, to an `OxiaCommand` or a refusal
 * (SB2-3.2, SB2-3.3).
 *
 * Pure, and shipped to the browser: the confirmation gate reads the text with this parser (`guard.ts`), and the
 * provider reads it again on the server with the connection's own context before any call, so what the editor
 * accepts and what runs are one parse. Flags are read as cobra and pflag read them: anywhere among the arguments,
 * `--` ends them, a long flag takes `=value` or the next word, a short flag its attached rest (`-tfloor`, `-t=floor`)
 * or the next word, and a boolean flag never takes the next word and refuses `=value`. Studio refuses a flag given
 * twice, where pflag keeps the last.
 *
 * Every refusal is a whole sentence that names a place or a flag and never quotes a value the user typed; a typed
 * word is echoed at most 40 characters, and a typed value never.
 */
import type { ShellRefusalCode, ShellWord } from "@/lib/db/console/shell-words";
import {
  OXIA_DEFAULT_PORT,
  OXIA_ECHO_WORD_CHARS,
  OXIA_INTERNAL_PREFIX,
  OXIA_LIST_DEFAULT_LIMIT,
  OXIA_MAX_LIMIT,
  OXIA_MAX_TEXT_BYTES,
  OXIA_SCAN_DEFAULT_LIMIT,
} from "./constants";
import { OXIA_VALUE_GLOBAL_FLAGS, oxiaWords } from "./lexer";

export type OxiaCommandComparison = "equal" | "floor" | "ceiling" | "lower" | "higher";

export type OxiaCommandRange =
  | { readonly kind: "bounds"; readonly min: string; readonly max: string }
  | { readonly kind: "prefix"; readonly prefix: string };

export type OxiaCommand =
  | {
      readonly kind: "get";
      readonly key: string;
      readonly comparison: OxiaCommandComparison;
      readonly partitionKey?: string;
      readonly index?: string;
      readonly hex: boolean;
    }
  | {
      readonly kind: "list";
      readonly range: OxiaCommandRange;
      readonly partitionKey?: string;
      readonly index?: string;
      readonly limit: number;
    }
  | {
      readonly kind: "range-scan";
      readonly range: OxiaCommandRange;
      readonly partitionKey?: string;
      readonly index?: string;
      readonly limit: number;
      readonly hex: boolean;
    };

export type OxiaCommandKind = OxiaCommand["kind"];

/** A global flag the text named that matched the connection, for the notice of SB2-5.4. */
export type MatchedGlobal = "service-address" | "namespace";

export interface ParsedOxiaCommand {
  readonly command: OxiaCommand;
  readonly matched: readonly MatchedGlobal[];
  /** 1-based line of the verb. */
  readonly line: number;
}

export type OxiaRefusalCode =
  | ShellRefusalCode
  | "empty"
  | "unknown-command"
  | "write-command"
  | "stream-command"
  | "not-client"
  | "unknown-flag"
  | "refused-flag"
  | "connection-flag"
  | "repeated-flag"
  | "bad-argument"
  | "conflicting-flags"
  | "internal-key"
  | "limit-out-of-range"
  | "nul-character"
  | "too-large";

export interface OxiaRefusal {
  readonly code: OxiaRefusalCode;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type OxiaParseResult =
  | { readonly ok: true; readonly parsed: ParsedOxiaCommand }
  | { readonly ok: false; readonly refusal: OxiaRefusal };

/**
 * What the parse is held to. `endpoint` and `namespace` are the connection's, normalised server-side by index.ts
 * (namespace "" read as "default"); the browser gate knows neither and passes undefined, which accepts -a and -n
 * with any value and leaves the comparison to the provider (SB2-12 D7).
 */
export interface OxiaParseContext {
  /** `oxiaEndpointText(options)`; undefined in the browser. */
  readonly endpoint?: string;
  /** The normalised namespace; undefined in the browser. */
  readonly namespace?: string;
  /** Whether the connection's read-only mode holds; undefined in the browser. */
  readonly readOnly?: boolean;
}

// ============================================================================
// The table (SB2-3.3)
// ============================================================================

type FlagName =
  | "comparison-type"
  | "partition-key"
  | "index"
  | "hex"
  | "include-version"
  | "key-min"
  | "key-max"
  | "prefix"
  | "limit";

interface FlagSpec {
  readonly name: FlagName;
  readonly shorthand?: string;
  readonly takes: "value" | "boolean";
}

const flagSpec = (name: FlagName, takes: FlagSpec["takes"], shorthand?: string): FlagSpec =>
  shorthand === undefined ? { name, takes } : { name, takes, shorthand };

const COMPARISON = flagSpec("comparison-type", "value", "t");
const PARTITION = flagSpec("partition-key", "value", "p");
const INDEX = flagSpec("index", "value");
const HEX = flagSpec("hex", "boolean");
const VERSION = flagSpec("include-version", "boolean", "v");
const KEY_MIN = flagSpec("key-min", "value", "s");
const KEY_MAX = flagSpec("key-max", "value", "e");
const PREFIX = flagSpec("prefix", "value");
const LIMIT = flagSpec("limit", "value");

interface VerbSpec {
  readonly verb: OxiaCommandKind;
  readonly aliases: readonly string[];
  readonly arguments: string;
  readonly flags: readonly FlagSpec[];
}

const LIST_FLAGS: readonly FlagSpec[] = [KEY_MIN, KEY_MAX, PARTITION, INDEX, PREFIX, LIMIT];

const VERBS: readonly VerbSpec[] = [
  {
    verb: "get",
    aliases: [],
    arguments: "KEY",
    flags: [COMPARISON, PARTITION, INDEX, HEX, VERSION],
  },
  {
    verb: "list",
    aliases: ["ls"],
    arguments: "[MIN [MAX]]",
    flags: LIST_FLAGS,
  },
  {
    verb: "range-scan",
    aliases: ["scan"],
    arguments: "[MIN [MAX]]",
    flags: [...LIST_FLAGS, VERSION, HEX],
  },
];

/** A flag as a usage line prints it: `-t|--comparison-type`, or `--index` for a flag with no shorthand. */
const usageSpelling = (spec: FlagSpec): string =>
  spec.shorthand === undefined ? `--${spec.name}` : `-${spec.shorthand}|--${spec.name}`;

/** The table as data, for labels.ts, the provider doc test and statementLanguage. */
export const OXIA_COMMAND_TABLE: ReadonlyArray<{
  readonly verb: OxiaCommandKind;
  readonly aliases: readonly string[];
  readonly arguments: string;
  readonly flags: readonly string[];
}> = Object.freeze(
  VERBS.map((spec) =>
    Object.freeze({
      verb: spec.verb,
      aliases: Object.freeze([...spec.aliases]),
      arguments: spec.arguments,
      flags: Object.freeze(spec.flags.map(usageSpelling)),
    }),
  ),
);

// ============================================================================
// Sentences (SB2-3.3)
// ============================================================================

/** A word the user typed, as a refusal may repeat it: at most 40 characters, cut between two of them. */
function bounded(text: string): string {
  const characters = Array.from(text);
  return characters.length > OXIA_ECHO_WORD_CHARS ? `${characters.slice(0, OXIA_ECHO_WORD_CHARS).join("")}...` : text;
}

/** A flag the user typed, without whatever follows its first `=`, which may be a value. */
const typedFlag = (text: string): string => bounded(text.split("=")[0]);

function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const count = (n: number): string => n.toLocaleString("en-US");

const EMPTY = "The editor holds no command: write one Oxia read, such as get /admin or list --prefix /admin/.";

/** SB2-3.3 `internal-key`, the parser's half of C10; key-scan.ts and objects.ts raise it too. */
export const OXIA_INTERNAL_KEY_SENTENCE = "Keys under __oxia/ are Oxia's own bookkeeping, which Studio never reads.";

/**
 * SB2-3.3 `write-command`: the sentence for a write verb, by whether the read-only mode holds (true), does not
 * (false) or is unknown (undefined). The mode is named only while it holds (O1).
 */
export function writeCommandSentence(verb: string, readOnly: boolean | undefined): string {
  const word = bounded(verb);
  return readOnly === true
    ? `${word} writes, and this connection is read-only. Studio's Oxia support also reads only in this version, so turning the mode off would not run it: write with the oxia CLI.`
    : `${word} writes, and Studio's Oxia support reads only in this version: write with the oxia CLI.`;
}

const streamSentence = (verb: string): string =>
  `${bounded(verb)} keeps a stream open until it is stopped, and Studio runs one bounded read per command: run it with the oxia CLI.`;

const WRITE_VERBS: readonly string[] = ["put", "delete", "del", "delete-range"];
const STREAM_VERBS: readonly string[] = ["notifications", "sequence-updates"];
const OTHER_COMMANDS: ReadonlySet<string> = new Set([
  "admin",
  "standalone",
  "shell",
  "coordinator",
  "server",
  "perf",
  "pprof",
  "health",
  "version",
]);

export const OXIA_REFUSED_COMMANDS: ReadonlyArray<{
  readonly verb: string;
  readonly code: OxiaRefusalCode;
  readonly message: string;
}> = Object.freeze([
  ...WRITE_VERBS.map((verb) =>
    Object.freeze({
      verb,
      code: "write-command" as const,
      message: writeCommandSentence(verb, undefined),
    }),
  ),
  ...STREAM_VERBS.map((verb) =>
    Object.freeze({
      verb,
      code: "stream-command" as const,
      message: streamSentence(verb),
    }),
  ),
]);

const authTokenReason = (flag: string): string =>
  `${flag} is refused: the connection's Token field authenticates every call, and a token typed here would be kept in the query history.`;

export const OXIA_REFUSED_FLAGS: ReadonlyArray<{
  readonly flag: string;
  readonly shorthand?: string;
  readonly reason: string;
}> = Object.freeze([
  Object.freeze({
    flag: "--internal-keys",
    reason: "--internal-keys lists Oxia's own bookkeeping keys under __oxia/, which Studio never reads.",
  }),
  Object.freeze({
    flag: "--request-timeout",
    reason: "--request-timeout is refused: the connection's Query Timeout bounds every command.",
  }),
  Object.freeze({
    flag: "--auth-token",
    reason: authTokenReason("--auth-token"),
  }),
  Object.freeze({
    flag: "--auth-token-file",
    reason: authTokenReason("--auth-token-file"),
  }),
  Object.freeze({
    flag: "--help",
    shorthand: "-h",
    reason: "Studio prints no help: the provider doc lists every command and flag Studio runs.",
  }),
]);

const COMPARISONS: readonly OxiaCommandComparison[] = ["equal", "floor", "ceiling", "lower", "higher"];

// ============================================================================
// Refusals
// ============================================================================

type Place = { readonly line: number; readonly column: number };

const at = (word: Place): Place => ({ line: word.line, column: word.column });

function refusal(code: OxiaRefusalCode, message: string, place?: Place): OxiaRefusal {
  return place === undefined ? { code, message } : { code, message, ...at(place) };
}

const refused = (code: OxiaRefusalCode, message: string, place?: Place): OxiaParseResult => ({
  ok: false,
  refusal: refusal(code, message, place),
});

const isFlagWord = (word: ShellWord): boolean => !word.quoted && word.text.length > 1 && word.text.startsWith("-");

// ============================================================================
// The -a check (F11): a pure host and port normalisation, no name resolved
// ============================================================================

const DECIMAL = /^[0-9]+$/;
const LARGEST_PORT = 65_535;

/** The typed `-a` value as `host:port`, lower case, port explicit; undefined when it does not split into both. */
function typedEndpoint(value: string): string | undefined {
  let host: string;
  let port: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return undefined;
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest === "") port = String(OXIA_DEFAULT_PORT);
    else if (rest.startsWith(":")) port = rest.slice(1);
    else return undefined;
  } else {
    const parts = value.split(":");
    if (parts.length > 2) return undefined;
    host = parts[0];
    port = parts.length === 2 ? parts[1] : String(OXIA_DEFAULT_PORT);
  }
  if (host === "" || host === "[]" || !DECIMAL.test(port)) return undefined;
  const number = Number(port);
  if (number < 1 || number > LARGEST_PORT) return undefined;
  return `${host.toLowerCase()}:${number}`;
}

// ============================================================================
// The parser
// ============================================================================

interface FlagValue {
  readonly spec: FlagSpec;
  readonly value: string | true;
  readonly word: ShellWord;
}

interface ReadState {
  readonly flags: Map<FlagName, FlagValue>;
  readonly positionals: ShellWord[];
  readonly matched: MatchedGlobal[];
  readonly globals: Set<string>;
}

type Step = { readonly next: number } | { readonly refusal: OxiaRefusal };

/** The plan-defined sentence for a value flag written last with no value after it. */
const missingValueSentence = (flag: string): string => `${flag} takes a value: write it after ${flag}.`;

/** The verb's own flag by long name or shorthand. */
function ownFlag(spec: VerbSpec, name: string, short: boolean): FlagSpec | undefined {
  return spec.flags.find((flag) => (short ? flag.shorthand === name : flag.name === name));
}

/** A refused flag by its typed name: `--internal-keys`, `--request-timeout`, the two token flags, `-h`, `--help`. */
function refusedFlag(shown: string): string | undefined {
  return OXIA_REFUSED_FLAGS.find((flag) => flag.flag === shown || flag.shorthand === shown)?.reason;
}

/** A global the CLI reads before or after the verb: `-a`, `-n` in both spellings, by its canonical name. */
function globalName(shown: string): "service-address" | "namespace" | undefined {
  if (shown === "-a" || shown === "--service-address") return "service-address";
  if (shown === "-n" || shown === "--namespace") return "namespace";
  return undefined;
}

/** -a and -n against the connection, when the context names it; the browser accepts any value. */
function checkGlobal(
  name: "service-address" | "namespace",
  shown: string,
  value: string,
  word: ShellWord,
  context: OxiaParseContext,
  state: ReadState,
): OxiaRefusal | undefined {
  if (state.globals.has(name)) return refusal("repeated-flag", `${shown} is given twice: give it once.`, word);
  state.globals.add(name);
  if (name === "service-address") {
    if (context.endpoint === undefined) return undefined;
    if (typedEndpoint(value) !== context.endpoint)
      return refusal(
        "connection-flag",
        `-a names another address than this connection's ${context.endpoint}: Host and Port on the connection decide where Studio connects.`,
        word,
      );
    state.matched.push("service-address");
    return undefined;
  }
  if (context.namespace === undefined) return undefined;
  if (value !== context.namespace)
    return refusal(
      "connection-flag",
      `-n names another namespace than this connection's \`${context.namespace}\`: Namespace is set on the connection, and empty means default.`,
      word,
    );
  state.matched.push("namespace");
  return undefined;
}

/** One value of a verb's flag, checked as SB2-3.3 bounds it. */
function checkValue(spec: FlagSpec, shown: string, value: string, word: ShellWord): OxiaRefusal | undefined {
  if (spec.name === "comparison-type" && !(COMPARISONS as readonly string[]).includes(value))
    return refusal("bad-argument", "-t takes equal, floor, ceiling, lower or higher.", word);
  if ((spec.name === "partition-key" || spec.name === "index" || spec.name === "prefix") && value === "")
    return refusal("bad-argument", `${shown} takes a value that is not empty.`, word);
  if (spec.name === "index" && value.includes("/"))
    return refusal(
      "bad-argument",
      "--index takes an index name, which cannot hold /: Oxia stores each index under its name.",
      word,
    );
  if (spec.name === "limit" && !(/^[1-9][0-9]*$/.test(value) && Number(value) <= OXIA_MAX_LIMIT))
    return refusal("limit-out-of-range", `--limit takes a whole number from 1 to ${OXIA_MAX_LIMIT}.`, word);
  return undefined;
}

/**
 * The flag word at `index`, read as pflag reads it, with the word after it when it takes that as its value.
 * Combined shorthands (`-vp key`) are read one letter at a time, as pflag reads them. The verb's word is no
 * flag's value, so a value flag written just before the verb has none.
 */
function readFlag(
  words: readonly ShellWord[],
  index: number,
  verbAt: number,
  spec: VerbSpec,
  context: OxiaParseContext,
  state: ReadState,
): Step {
  const word = words[index];
  const text = word.text;
  // One letter or one long name per pass: a long flag is one pass, a run of shorthands one pass per letter.
  const items: {
    readonly shown: string;
    readonly name: string;
    readonly short: boolean;
    readonly inline?: string;
  }[] = [];
  if (text.startsWith("--")) {
    const body = text.slice(2);
    const equals = body.indexOf("=");
    items.push({
      shown: `--${equals < 0 ? body : body.slice(0, equals)}`,
      name: equals < 0 ? body : body.slice(0, equals),
      short: false,
      ...(equals < 0 ? {} : { inline: body.slice(equals + 1) }),
    });
  } else {
    items.push({
      shown: `-${text[1]}`,
      name: text[1],
      short: true,
      inline: text.length > 2 ? text.slice(2) : undefined,
    });
  }
  let next = index + 1;
  for (let item = items.shift(); item !== undefined; item = items.shift()) {
    const { shown, name, short } = item;
    // A shorthand's attached rest is its value after an `=` (`-t=floor`) or as it stands (`-tfloor`).
    const inline =
      short && item.inline !== undefined && item.inline.startsWith("=") ? item.inline.slice(1) : item.inline;
    const reason = refusedFlag(shown);
    if (reason !== undefined) return { refusal: refusal("refused-flag", reason, word) };
    const global = globalName(shown);
    const own = global === undefined ? ownFlag(spec, name, short) : undefined;
    if (global === undefined && own === undefined) {
      const takes = joinWithAnd(spec.flags.map(usageSpelling));
      return {
        refusal: refusal(
          "unknown-flag",
          `${spec.verb} takes no flag ${typedFlag(short ? shown : text)}: it takes ${takes}.`,
          word,
        ),
      };
    }
    if (own?.takes === "boolean") {
      if (!short && inline !== undefined)
        return {
          refusal: refusal("bad-argument", `${shown} takes no value: write ${shown} alone.`, word),
        };
      if (short && item.inline !== undefined) {
        if (item.inline.startsWith("="))
          return {
            refusal: refusal("bad-argument", `${shown} takes no value: write ${shown} alone.`, word),
          };
        // A run of shorthands: the next letter is a flag of its own.
        items.push({
          shown: `-${item.inline[0]}`,
          name: item.inline[0],
          short: true,
          inline: item.inline.length > 1 ? item.inline.slice(1) : undefined,
        });
      }
      if (state.flags.has(own.name))
        return {
          refusal: refusal("repeated-flag", `--${own.name} is given twice: give it once.`, word),
        };
      state.flags.set(own.name, { spec: own, value: true, word });
      continue;
    }
    let value = inline;
    if (value === undefined) {
      if (next >= words.length || next === verbAt)
        return {
          refusal: refusal("bad-argument", missingValueSentence(shown), word),
        };
      value = words[next].text;
      next += 1;
    }
    if (global !== undefined) {
      const failed = checkGlobal(global, shown, value, word, context, state);
      if (failed !== undefined) return { refusal: failed };
      continue;
    }
    const flag = own as FlagSpec;
    if (state.flags.has(flag.name))
      return {
        refusal: refusal("repeated-flag", `--${flag.name} is given twice: give it once.`, word),
      };
    const failed = checkValue(flag, shown, value, word);
    if (failed !== undefined) return { refusal: failed };
    state.flags.set(flag.name, { spec: flag, value, word });
  }
  return { next };
}

/** Where the verb stands: the first word that is neither a flag nor the value a persistent flag takes before it. */
function verbIndex(words: readonly ShellWord[]): number {
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (!isFlagWord(word)) return index;
    if (word.text === "--") return index + 1;
    if (OXIA_VALUE_GLOBAL_FLAGS.has(word.text)) index += 1;
  }
  return words.length;
}

const flagText = (state: ReadState, name: FlagName): string | undefined => {
  const found = state.flags.get(name);
  return found === undefined ? undefined : (found.value as string);
};

/** The verb's command from its flags and positionals, or the refusal of SB2-3.3 that comes first. */
function build(spec: VerbSpec, state: ReadState, verbWord: ShellWord): OxiaCommand | OxiaRefusal {
  const positionals = state.positionals;
  const partitionKey = flagText(state, "partition-key");
  const index = flagText(state, "index");
  const optional = {
    ...(partitionKey === undefined ? {} : { partitionKey }),
    ...(index === undefined ? {} : { index }),
  };
  if (spec.verb === "get") {
    if (positionals.length === 0)
      return refusal(
        "bad-argument",
        "get takes one key: write get followed by the key, in single quotes if it holds a space.",
        verbWord,
      );
    if (positionals.length > 1) {
      const more = positionals.length - 1;
      return refusal(
        "bad-argument",
        `get takes one key, and ${count(more)} more ${more === 1 ? "word follows" : "words follow"} it: write the key between single quotes if it holds a space.`,
        positionals[1],
      );
    }
    const key = positionals[0];
    const comparison = (flagText(state, "comparison-type") ?? "equal") as OxiaCommandComparison;
    if (comparison !== "equal" && key.text === "")
      return refusal(
        "bad-argument",
        "A floor, ceiling, lower or higher get needs a key that is not empty: Oxia answers the empty key differently under each key order. For the first key, use list --limit 1.",
        key,
      );
    if (key.text.startsWith(OXIA_INTERNAL_PREFIX)) return refusal("internal-key", OXIA_INTERNAL_KEY_SENTENCE, key);
    return {
      kind: "get",
      key: key.text,
      comparison,
      ...optional,
      hex: state.flags.has("hex"),
    };
  }
  if (positionals.length > 2)
    return refusal(
      "bad-argument",
      `${spec.verb} takes at most two keys, MIN and MAX: write a key between single quotes if it holds a space.`,
      positionals[2],
    );
  const min = state.flags.get("key-min");
  const max = state.flags.get("key-max");
  const prefix = state.flags.get("prefix");
  if (prefix !== undefined && (min !== undefined || max !== undefined || positionals.length > 0))
    return refusal(
      "conflicting-flags",
      "--prefix reads every key beginning with its text, so it takes no -s, -e, MIN or MAX.",
      prefix.word,
    );
  if (prefix !== undefined && index !== undefined)
    return refusal(
      "conflicting-flags",
      "--prefix reads primary keys, so it does not combine with --index, whose bounds are secondary keys.",
      prefix.word,
    );
  if (positionals.length > 0 && (min !== undefined || max !== undefined))
    return refusal(
      "conflicting-flags",
      `${spec.verb} takes its bounds either as MIN and MAX or as -s and -e, not both.`,
      positionals[0],
    );
  // Each bound with the word that wrote it, so a refusal names that word's place.
  const minWord = positionals[0] ?? min?.word;
  const maxWord = positionals[1] ?? max?.word;
  const minText = positionals[0]?.text ?? (min?.value as string | undefined) ?? "";
  const maxText = positionals[1]?.text ?? (max?.value as string | undefined) ?? "";
  const written: readonly (readonly [string, ShellWord | undefined])[] =
    prefix === undefined
      ? [
          [minText, minWord],
          [maxText, maxWord],
        ]
      : [[prefix.value as string, prefix.word]];
  if (prefix === undefined && index !== undefined && maxText === "")
    return refusal(
      "bad-argument",
      "--index needs an upper bound: Oxia reads index keys up to MAX (or -e), and an empty upper bound reads nothing.",
      state.flags.get("index")?.word,
    );
  const internal = written.find(([bound]) => bound.startsWith(OXIA_INTERNAL_PREFIX));
  if (internal !== undefined) return refusal("internal-key", OXIA_INTERNAL_KEY_SENTENCE, internal[1]);
  const range: OxiaCommandRange =
    prefix === undefined
      ? { kind: "bounds", min: minText, max: maxText }
      : { kind: "prefix", prefix: prefix.value as string };
  const limitText = flagText(state, "limit");
  const limit =
    limitText === undefined
      ? spec.verb === "list"
        ? OXIA_LIST_DEFAULT_LIMIT
        : OXIA_SCAN_DEFAULT_LIMIT
      : Number(limitText);
  if (spec.verb === "list") return { kind: "list", range, ...optional, limit };
  return {
    kind: "range-scan",
    range,
    ...optional,
    limit,
    hex: state.flags.has("hex"),
  };
}

const encoder = new TextEncoder();

/** The CLI's name and its client subcommand, as a pasted line's lead spells them (SB2-3.1). */
const CLI_NAME = "oxia";
const CLIENT_SUBCOMMAND = "client";

/** One Oxia read command, or the first refusal SB2-3.3 lists for it. */
export function parseOxiaCommand(text: string, context: OxiaParseContext): OxiaParseResult {
  if (encoder.encode(text).length > OXIA_MAX_TEXT_BYTES)
    return refused(
      "too-large",
      `The command is longer than ${count(OXIA_MAX_TEXT_BYTES)} bytes, the most an Oxia command holds in Studio: shorten it.`,
    );
  const read = oxiaWords(text);
  if (!read.ok) return { ok: false, refusal: read.refusal };
  const words = read.words;
  const lead = read.lead;
  if (words.length === 0) return refused("empty", EMPTY);

  const verbAt = verbIndex(words);
  const verbWord = words[verbAt];
  if (verbWord === undefined) return refused("empty", EMPTY);
  const typed = verbWord.text;
  const afterOxia =
    lead.some((word) => word.text === CLI_NAME) && !lead.some((word) => word.text === CLIENT_SUBCOMMAND);
  if (afterOxia && OTHER_COMMANDS.has(typed))
    return refused(
      "not-client",
      `oxia ${bounded(typed)} is not a client read: Studio runs oxia client get, list and range-scan, and the oxia CLI runs the rest.`,
      verbWord,
    );
  if (WRITE_VERBS.includes(typed))
    return refused("write-command", writeCommandSentence(typed, context.readOnly), verbWord);
  if (STREAM_VERBS.includes(typed)) return refused("stream-command", streamSentence(typed), verbWord);
  const spec = VERBS.find((candidate) => candidate.verb === typed || candidate.aliases.includes(typed));
  if (spec === undefined)
    return refused(
      "unknown-command",
      `${bounded(typed)} is not a command Studio runs on Oxia: it runs get, list (ls) and range-scan (scan).`,
      verbWord,
    );

  // A NUL has no spelling on any command line, so a word holding one names nothing that can be run (F17).
  for (const word of words) {
    const offset = word.text.indexOf("\u0000");
    if (offset < 0) continue;
    return refused(
      "nul-character",
      `The word at line ${word.line}, column ${word.column + 1} holds a NUL character, which no command line can pass: open such a key from the Keys panel, where its Source tab reads it.`,
      word,
    );
  }

  const state: ReadState = {
    flags: new Map(),
    positionals: [],
    matched: [],
    globals: new Set(),
  };
  let flagsEnded = false;
  for (let index = 0; index < words.length; ) {
    const word = words[index];
    if (index === verbAt) {
      index += 1;
      continue;
    }
    if (flagsEnded || !isFlagWord(word)) {
      state.positionals.push(word);
      index += 1;
      continue;
    }
    if (word.text === "--") {
      flagsEnded = true;
      index += 1;
      continue;
    }
    const step = readFlag(words, index, verbAt, spec, context, state);
    if ("refusal" in step) return { ok: false, refusal: step.refusal };
    index = step.next;
  }
  const built = build(spec, state, verbWord);
  if ("code" in built) return { ok: false, refusal: built };
  return {
    ok: true,
    parsed: { command: built, matched: state.matched, line: verbWord.line },
  };
}
