/**
 * The etcdctl subset: editor text to one typed command (spec 5.1).
 *
 * Pure, and shipped to the browser: the provider runs what this module answers, and the
 * confirmation gate classifies the same answer (guard.ts), so what runs and what asks are one parse
 * (spec 5.5). It reads the text only through lexer.ts, whose words it takes as they are: it never
 * unquotes text itself.
 *
 * The grammar is a declared table (open/closed, spec 3.5): each command's words, its arguments, the
 * flags it takes, and the flags etcdctl has that it refuses, with the reason. Every name and
 * spelling is etcdctl v3.7.2's own (ctl.go and each command's file), read as cobra and pflag read
 * them: flags may stand anywhere among the arguments, `--` ends them, a boolean flag never takes
 * the next word and reads any value strconv.ParseBool reads, and a value flag takes `=value` or the
 * next word. Where etcdctl reads a spelling in a way a user would not expect, the subset refuses it
 * rather than guess: an integer in another base (pflag reads --limit=010 as octal 8), a flag given
 * twice (pflag keeps the last), an abbreviated command (cobra runs `ge` as get), a third positional
 * (etcdctl drops it), and a lease id with a sign (the ids etcd picks are positive, and Studio does not
 * address a negative one a client chose). Each refusal is a whole sentence that names what it refused,
 * and never quotes a flag's value, a value or a line.
 */
import { INT64_MAX, INT64_MIN } from "./keys";
import { isFlagText, type LexRefusalCode, type SplitLine, splitWords, type Word } from "./lexer";

// ============================================================================
// The command a text parses to (Contract C2)
// ============================================================================

export type EtcdConsistency = "l" | "s";

export type TxnCompareOperator = "=" | "!=" | "<" | ">";

/** A compare's key and value are bytes, since a txn line's Go escapes are bytes (spec 5.1.4). */
export type TxnCompareSpec =
  | {
      readonly target: "create" | "mod" | "version";
      readonly key: Uint8Array;
      readonly operator: TxnCompareOperator;
      /** A decimal integer as strconv.ParseInt reads it in base 10, written without sign or zeros it needs not. */
      readonly operand: string;
    }
  | {
      readonly target: "lease";
      readonly key: Uint8Array;
      readonly operator: TxnCompareOperator;
      /** The lease id as 16 lowercase hexadecimal digits, "0000000000000000" for no lease. */
      readonly operand: string;
    }
  | {
      readonly target: "value";
      readonly key: Uint8Array;
      readonly operator: TxnCompareOperator;
      readonly operand: Uint8Array;
    };

export type TxnRequestSpec =
  | {
      readonly kind: "get";
      readonly key: Uint8Array;
      readonly rangeEnd?: Uint8Array;
      readonly prefix: boolean;
      readonly fromKey: boolean;
      /** The typed --limit; absent when none was typed, or --limit=0, etcdctl's "no limit". */
      readonly limit?: number;
      /** A positive decimal revision. */
      readonly revision?: string;
      readonly keysOnly: boolean;
      readonly countOnly: boolean;
      readonly consistency: EtcdConsistency;
    }
  | {
      readonly kind: "put";
      readonly key: Uint8Array;
      /** Empty with --ignore-value. */
      readonly value: Uint8Array;
      /** The lease id as 16 lowercase hexadecimal digits; absent for no lease, --lease=0 included. */
      readonly lease?: string;
      readonly prevKv: boolean;
      readonly ignoreValue: boolean;
      readonly ignoreLease: boolean;
    }
  | {
      readonly kind: "del";
      readonly key: Uint8Array;
      readonly rangeEnd?: Uint8Array;
      readonly prefix: boolean;
      readonly fromKey: boolean;
      readonly prevKv: boolean;
    };

export type EtcdCommand =
  | TxnRequestSpec
  | {
      readonly kind: "txn";
      readonly compares: readonly TxnCompareSpec[];
      readonly success: readonly TxnRequestSpec[];
      readonly failure: readonly TxnRequestSpec[];
    }
  | {
      readonly kind: "watch";
      readonly key: Uint8Array;
      readonly rangeEnd?: Uint8Array;
      readonly prefix: boolean;
      readonly revision?: string;
      readonly prevKv: boolean;
    }
  | { readonly kind: "lease-grant"; readonly ttlSeconds: number }
  | { readonly kind: "lease-revoke"; readonly leaseHex: string }
  | { readonly kind: "lease-timetolive"; readonly leaseHex: string; readonly keys: boolean }
  | { readonly kind: "lease-list" }
  | { readonly kind: "lease-keep-alive-once"; readonly leaseHex: string }
  | { readonly kind: "member-list"; readonly consistency: EtcdConsistency }
  | { readonly kind: "endpoint-status" }
  | { readonly kind: "endpoint-health" }
  | { readonly kind: "alarm-list" }
  | { readonly kind: "auth-status" }
  | { readonly kind: "user-list" }
  | { readonly kind: "user-get"; readonly name: string; readonly detail: boolean }
  | { readonly kind: "role-list" }
  | { readonly kind: "role-get"; readonly name: string };

export type EtcdCommandKind = EtcdCommand["kind"];

export interface ParsedCommand {
  readonly command: EtcdCommand;
  /** From `--command-timeout`, in whole milliseconds rounded up; absent when not given. */
  readonly commandTimeoutMs?: number;
  /** 1-based line the command word is on. */
  readonly line: number;
}

export type CommandRefusalCode =
  | LexRefusalCode
  | "empty"
  | "unknown-command"
  | "maintenance-command"
  | "not-offered"
  | "blocking-command"
  | "unknown-flag"
  | "refused-flag"
  | "global-flag"
  | "bad-argument"
  | "conflicting-flags"
  | "limit-too-large"
  | "second-command"
  | "txn-syntax";

export interface CommandRefusal {
  readonly code: CommandRefusalCode;
  /** The whole sentence the user reads; names what was refused and, where one exists, what to do. */
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export type ParseResult =
  | { readonly ok: true; readonly parsed: ParsedCommand }
  | { readonly ok: false; readonly refusal: CommandRefusal };

/**
 * The bounds a command is held to, each from the connection or the provider rather than the text:
 * the rows a result holds (spec 5.4), P, the first page size a ranged get inside a txn is sent
 * with (spec 5.1.4), and the caps --command-timeout meets (spec 5.1.2, 5.3). A caller with no
 * connection, such as the confirmation gate, passes Infinity for a cap it cannot know.
 */
export interface EtcdParseLimits {
  readonly maxLimit: number;
  readonly txnRangeLimit: number;
  readonly maxCommandTimeoutMs: number;
  readonly maxWatchWindowMs: number;
}

// ============================================================================
// Sentences and values
// ============================================================================

const ECHO_LENGTH = 40;

/** A word the user typed, as a refusal may repeat it: at most 40 characters, cut between two of them. */
function bounded(text: string): string {
  const characters = Array.from(text);
  return characters.length > ECHO_LENGTH ? `${characters.slice(0, ECHO_LENGTH).join("")}...` : text;
}

/** A name the user typed, without whatever follows its first `=`: that may be a value or a password. */
const named = (text: string): string => bounded(text.split("=")[0]);

function joinWith(items: readonly string[], last: "and" | "or"): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

const at = (word: { readonly line: number; readonly column: number }) => ({ line: word.line, column: word.column });

function refusal(code: CommandRefusalCode, message: string, place?: { line: number; column: number }): CommandRefusal {
  return place === undefined ? { code, message } : { code, message, ...place };
}

const isRefusal = (value: object): value is CommandRefusal => "code" in value && "message" in value;

const PLAIN_DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SIGNED_DECIMAL = /^[+-]?[0-9]+$/;
const HEX_ID = /^[0-9a-fA-F]+$/;
/** etcd's ceiling on a lease's TTL, in seconds (MaxLeaseTTL, server/lease/lessor.go). */
const MAX_LEASE_TTL = 9_000_000_000;
const LARGEST_LEASE_ID = INT64_MAX.toString(16);

/** A decimal integer in an INT64, as strconv.ParseInt(text, 10, 64) reads it, written plainly. */
function signedInt64(text: string): string | undefined {
  if (!SIGNED_DECIMAL.test(text)) return undefined;
  const value = BigInt(text);
  return value > INT64_MAX || value < INT64_MIN ? undefined : value.toString();
}

type LeaseId =
  | { readonly kind: "ok"; readonly hex: string }
  | { readonly kind: "signed" }
  | { readonly kind: "not-hex" }
  | { readonly kind: "past" };

const SIGNED_HEX_ID = /^[+-][0-9a-fA-F]+$/;
const NEGATIVE_LEASE = "Studio does not address a negative id, which etcd holds only when a client chose it";
const UNSIGNED_LEASE = `as lease list prints the ids etcd grants, such as 694d77aa9e38260f: ${NEGATIVE_LEASE}`;

/**
 * A lease id in hexadecimal, any padding and case, as etcdctl's base-16 parse reads it, but with
 * no sign. Written as `lease list` prints it, 16 lowercase digits. The ids etcd picks itself are
 * positive (v3_server.go LeaseGrant), but etcd also grants an id a client chooses, a negative one
 * included (measured on v3.7.2: a grant of -5 was granted, and etcdctl's lease list printed
 * -000000000000005); Studio does not address such a lease.
 */
function leaseId(text: string): LeaseId {
  if (SIGNED_HEX_ID.test(text)) return { kind: "signed" };
  if (!HEX_ID.test(text)) return { kind: "not-hex" };
  const digits = text.replace(/^0+/, "").toLowerCase();
  if (digits.length > 16 || (digits.length === 16 && digits[0] > "7")) return { kind: "past" };
  return { kind: "ok", hex: digits.padStart(16, "0") };
}

const PARSE_BOOL: ReadonlyMap<string, boolean> = new Map([
  ["1", true],
  ["t", true],
  ["T", true],
  ["true", true],
  ["TRUE", true],
  ["True", true],
  ["0", false],
  ["f", false],
  ["F", false],
  ["false", false],
  ["FALSE", false],
  ["False", false],
]);

const DURATION_UNITS: ReadonlyMap<string, number> = new Map([
  ["ns", 1],
  ["us", 1e3],
  ["µs", 1e3],
  ["μs", 1e3],
  ["ms", 1e6],
  ["s", 1e9],
  ["m", 6e10],
  ["h", 3.6e12],
]);
const DURATION_PART = /^([0-9]*)(?:\.([0-9]*))?([^0-9.]*)/;
const ZERO = BigInt(0);
const TEN = BigInt(10);
/** 2^63: what time.ParseDuration lets one part and the sum reach before it applies the sign. */
const DURATION_CEILING = INT64_MAX + BigInt(1);
const NANOS_PER_MS = BigInt(1_000_000);

/**
 * time.ParseDuration, to nanoseconds, with Go's own arithmetic, so a duration reads as etcdctl reads it:
 * each part's whole digits times its unit, exactly, plus its fraction as Go adds it,
 * float64(f) * (unit / scale) truncated, where f holds the fraction's digits until one more would pass
 * 2^63 and scale is ten for each digit f holds. Undefined where Go refuses the text.
 */
function goDurationNanos(text: string): bigint | undefined {
  let rest = text;
  let negative = false;
  if (rest.startsWith("-") || rest.startsWith("+")) {
    negative = rest.startsWith("-");
    rest = rest.slice(1);
  }
  if (rest === "0") return ZERO;
  if (rest === "") return undefined;
  let total = ZERO;
  while (rest !== "") {
    const [whole, integer, fraction = "", unit] = DURATION_PART.exec(rest) as RegExpExecArray;
    const unitNanos = DURATION_UNITS.get(unit);
    if ((integer === "" && fraction === "") || unitNanos === undefined) return undefined;
    let kept = ZERO;
    let scale = 1;
    let full = false;
    for (const digit of fraction) {
      const next = kept * TEN + BigInt(digit);
      if (full || kept > INT64_MAX / TEN || next > DURATION_CEILING) {
        full = true;
        continue;
      }
      kept = next;
      scale *= 10;
    }
    total += BigInt(integer) * BigInt(unitNanos) + BigInt(Math.trunc(Number(kept) * (unitNanos / scale)));
    rest = rest.slice(whole.length);
  }
  // Every part adds, so the overflow checks Go makes as it goes come to one bound on the sum: 2^63 ns
  // before a minus sign is applied, and 2^63 - 1 without one.
  return total > (negative ? DURATION_CEILING : INT64_MAX) ? undefined : negative ? -total : total;
}

const formatMs = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

// ============================================================================
// The declared grammar (spec 5.1.3)
// ============================================================================

type FlagValue = boolean | number | string | undefined;
type ValueParse = { readonly value: FlagValue } | { readonly message: string };

interface FlagSpec {
  /** The name without its dashes. */
  readonly name: string;
  readonly takes: "boolean" | "value";
  /** How 5.1.3 writes the flag, `--limit=<n>`. */
  readonly display: string;
  /** A value flag's example, for the sentence that asks for one. */
  readonly example?: string;
  readonly parse?: (text: string) => ValueParse;
}

interface RefusedFlagSpec {
  readonly name: string;
  /** The one-letter form etcdctl also takes, `i` for `-i`. */
  readonly shorthand?: string;
  readonly reason: string;
}

interface FlagOccurrence {
  readonly value: FlagValue;
  readonly word: Word;
}

interface BuildInput {
  /** The command word, where a refusal about the whole command points. */
  readonly commandWord: Word;
  readonly positionals: readonly Word[];
  readonly flags: ReadonlyMap<string, FlagOccurrence>;
  readonly limits: EtcdParseLimits;
  /** A request inside a txn body is held to the txn's own bounds (spec 5.1.4). */
  readonly inTxn: boolean;
}

interface CommandSpec {
  readonly words: readonly string[];
  readonly kind: EtcdCommandKind;
  readonly arguments: string;
  readonly flags: readonly FlagSpec[];
  readonly refusedFlags: readonly RefusedFlagSpec[];
  /** How the refusal of an unknown flag shows a word that begins with -, where one can. */
  readonly dashExample?: string;
  /** `--` introduces a program to run (watch), which Studio refuses, instead of ending the flags. */
  readonly dashDashRunsProgram?: true;
  readonly build: (input: BuildInput) => EtcdCommand | CommandRefusal;
}

const boolean = (name: string): FlagSpec => ({ name, takes: "boolean", display: `--${name}` });

const valued = (name: string, placeholder: string, example: string, parse: (text: string) => ValueParse): FlagSpec => ({
  name,
  takes: "value",
  display: `--${name}=${placeholder}`,
  example,
  parse,
});

const PLAIN_LIMIT =
  "--limit takes a whole number written in plain decimal digits, such as --limit=50: etcdctl reads 010 as octal 8 and 0x10 as 16, so Studio takes only the plain form.";
const PLAIN_REV =
  "--rev takes a revision, a whole number of 1 or more written in plain decimal digits, such as --rev=42.";
const LEASE_FLAG =
  "--lease takes a lease id in hexadecimal, as lease list prints it, such as 694d77aa9e38260f; 0 means no lease.";

const LIMIT_FLAG = valued("limit", "<n>", "50", (text) =>
  PLAIN_DECIMAL.test(text) ? { value: text === "0" ? undefined : Number(text) } : { message: PLAIN_LIMIT },
);

const REV_FLAG = valued("rev", "<n>", "42", (text) => {
  if (!PLAIN_DECIMAL.test(text) || text === "0") return { message: PLAIN_REV };
  return BigInt(text) > INT64_MAX
    ? { message: `--rev is past the largest revision etcd holds, ${INT64_MAX}.` }
    : { value: text };
});

const CONSISTENCY_FLAG = valued("consistency", "l|s", "s", (text) =>
  text === "l" || text === "s"
    ? { value: text }
    : { message: "--consistency takes l (linearizable) or s (serializable)." },
);

const LEASE_ID_FLAG = valued("lease", "<hex id>", "694d77aa9e38260f", (text) => {
  const id = leaseId(text);
  if (id.kind === "signed") return { message: `--lease takes a lease id without a sign, ${UNSIGNED_LEASE}.` };
  if (id.kind === "not-hex") return { message: LEASE_FLAG };
  if (id.kind === "past") return { message: `--lease is past the largest lease id, ${LARGEST_LEASE_ID}.` };
  return { value: id.hex === "0".repeat(16) ? undefined : id.hex };
});

const TIMEOUT_FLAG = valued("command-timeout", "<duration>", "5s", (text) => {
  const nanos = goDurationNanos(text);
  if (nanos === undefined) return { message: "--command-timeout takes a Go duration such as 500ms, 5s or 1m30s." };
  if (nanos <= ZERO) return { message: "--command-timeout must be longer than zero." };
  // Up to a whole millisecond, in integers: 2^63 - 1 ns is fewer than 2^53 ms, so the number is exact.
  return { value: Number((nanos + NANOS_PER_MS - BigInt(1)) / NANOS_PER_MS) };
});

// Spec E14: a sort or a revision filter makes the server load the whole range, whatever the limit.
const WHOLE_RANGE = "the server loads the whole range into memory for it, whatever the limit";
const NO_TERMINAL = "Studio has no terminal to prompt in";
// Spec E3: Studio dials only the configured endpoint.
const CLUSTER_FLAG: RefusedFlagSpec = {
  name: "cluster",
  reason: "Studio dials only the configured endpoint, never the addresses the members advertise",
};

const flag = (flags: ReadonlyMap<string, FlagOccurrence>, name: string): FlagValue => flags.get(name)?.value;
const isSet = (flags: ReadonlyMap<string, FlagOccurrence>, name: string): boolean => flag(flags, name) === true;

/** The later of two flag words, for a refusal of the two together. */
function later(flags: ReadonlyMap<string, FlagOccurrence>, a: string, b: string): { line: number; column: number } {
  const first = flags.get(a)?.word as Word;
  const second = flags.get(b)?.word as Word;
  const secondIsLater = second.line > first.line || (second.line === first.line && second.column > first.column);
  return at(secondIsLater ? second : first);
}

const PREFIX_FROM_KEY = "`--prefix` and `--from-key` cannot be set at the same time, choose one.";

/** A key and an optional range end, with the rules 5.1.3 states for both; `emptyKey` says why a key must not be empty. */
function keyAndRange(
  name: string,
  input: BuildInput,
  whole: { readonly prefix: boolean; readonly fromKey: boolean },
  emptyKey: string,
): { readonly key: Uint8Array; readonly rangeEnd?: Uint8Array } | CommandRefusal {
  const { positionals, commandWord } = input;
  if (positionals.length === 0 || positionals.length > 2)
    return refusal(
      "bad-argument",
      `${name} needs a key and takes at most a range end: ${name} <key> [<range_end>].`,
      at(positionals[2] ?? commandWord),
    );
  const [key, rangeEnd] = positionals;
  if (rangeEnd !== undefined && (whole.prefix || whole.fromKey))
    return refusal(
      "bad-argument",
      `${name} takes no range end beside --prefix or --from-key: they name the range themselves.`,
      at(rangeEnd),
    );
  if (key.bytes.length === 0 && !whole.prefix && !whole.fromKey)
    return refusal("bad-argument", `${name} needs a key that is not empty, ${emptyKey}.`, at(key));
  if (rangeEnd !== undefined && rangeEnd.bytes.length === 0)
    return refusal(
      "bad-argument",
      `The range end of ${name} is empty, which etcd reads as the key alone: leave it out, or write the key the range ends before.`,
      at(rangeEnd),
    );
  return rangeEnd === undefined ? { key: key.bytes } : { key: key.bytes, rangeEnd: rangeEnd.bytes };
}

function buildGet(input: BuildInput): EtcdCommand | CommandRefusal {
  const { flags, limits } = input;
  const prefix = isSet(flags, "prefix");
  const fromKey = isSet(flags, "from-key");
  const keysOnly = isSet(flags, "keys-only");
  const countOnly = isSet(flags, "count-only");
  if (input.positionals.length > 0 && input.positionals.length <= 2) {
    if (prefix && fromKey) return refusal("conflicting-flags", PREFIX_FROM_KEY, later(flags, "prefix", "from-key"));
    if (keysOnly && countOnly)
      return refusal(
        "conflicting-flags",
        "`--keys-only` and `--count-only` cannot be set at the same time, choose one.",
        later(flags, "keys-only", "count-only"),
      );
  }
  const range = keyAndRange(
    "get",
    input,
    { prefix, fromKey },
    'as etcd answers "key is not provided": an empty key with --prefix or --from-key reads every key',
  );
  if (isRefusal(range)) return range;
  const limit = flag(flags, "limit") as number | undefined;
  const limitWord = flags.get("limit")?.word as Word;
  const ranged = range.rangeEnd !== undefined || prefix || fromKey;
  if (limit !== undefined && limit > limits.maxLimit)
    return refusal(
      "limit-too-large",
      `--limit is above the most rows a result holds, ${limits.maxLimit}: ask for ${limits.maxLimit} or fewer.`,
      at(limitWord),
    );
  if (input.inTxn && ranged && !countOnly && limit !== undefined && limit > limits.txnRangeLimit)
    return refusal(
      "limit-too-large",
      `--limit on line ${limitWord.line} is above ${limits.txnRangeLimit}, the most rows a ranged get inside a txn reads, because etcd builds a txn's whole answer at once: ask for ${limits.txnRangeLimit} or fewer.`,
      at(limitWord),
    );
  const revision = flag(flags, "rev") as string | undefined;
  const consistency = (flag(flags, "consistency") ?? "l") as EtcdConsistency;
  return {
    kind: "get",
    ...range,
    prefix,
    fromKey,
    ...(limit === undefined ? {} : { limit }),
    ...(revision === undefined ? {} : { revision }),
    keysOnly,
    countOnly,
    consistency,
  };
}

function buildPut(input: BuildInput): EtcdCommand | CommandRefusal {
  const { positionals, flags, commandWord } = input;
  const ignoreValue = isSet(flags, "ignore-value");
  const ignoreLease = isSet(flags, "ignore-lease");
  const lease = flag(flags, "lease") as string | undefined;
  if (positionals.length === 0)
    return refusal(
      "bad-argument",
      "put needs a key and a value: put <key> <value>, or put <key> --ignore-value.",
      at(commandWord),
    );
  if (ignoreValue && positionals.length > 1)
    return refusal(
      "bad-argument",
      "put takes no value beside --ignore-value, which keeps the key's current value.",
      at(positionals[1]),
    );
  if (!ignoreValue && positionals.length === 1)
    return refusal(
      "bad-argument",
      "put needs a value after the key, since Studio has no standard input to read it from: write the value after the key, or use --ignore-value to keep the current one.",
      at(positionals[0]),
    );
  if (positionals.length > 2) {
    const third = positionals[2];
    const example = input.inTxn ? 'put /key "a b"' : "put /key 'a b'";
    return refusal(
      "bad-argument",
      `put takes a key and a value, and the word at line ${third.line}, column ${third.column + 1} is a third: quote a value that holds spaces, as in ${example}.`,
      at(third),
    );
  }
  const [key, value] = positionals;
  if (key.bytes.length === 0)
    return refusal(
      "bad-argument",
      'put needs a key that is not empty, as etcd answers "key is not provided".',
      at(key),
    );
  if (lease !== undefined && ignoreLease)
    return refusal(
      "bad-argument",
      'put takes no --lease beside --ignore-lease, which keeps the key\'s current lease: etcd would answer "lease is provided".',
      later(flags, "lease", "ignore-lease"),
    );
  return {
    kind: "put",
    key: key.bytes,
    value: ignoreValue ? new Uint8Array() : value.bytes,
    ...(lease === undefined ? {} : { lease }),
    prevKv: isSet(flags, "prev-kv"),
    ignoreValue,
    ignoreLease,
  };
}

function buildDel(input: BuildInput): EtcdCommand | CommandRefusal {
  const { flags } = input;
  const prefix = isSet(flags, "prefix");
  const fromKey = isSet(flags, "from-key");
  const prevKv = isSet(flags, "prev-kv");
  if (input.positionals.length > 0 && input.positionals.length <= 2 && prefix && fromKey)
    return refusal("conflicting-flags", PREFIX_FROM_KEY, later(flags, "prefix", "from-key"));
  const range = keyAndRange(
    "del",
    input,
    { prefix, fromKey },
    'as etcd answers "key is not provided": an empty key with --prefix or --from-key deletes every key',
  );
  if (isRefusal(range)) return range;
  // Spec E14: DeleteRangeRequest has no limit, so no bound holds the pairs --prev-kv would return.
  if (prevKv && (range.rangeEnd !== undefined || prefix || fromKey))
    return refusal(
      "conflicting-flags",
      "del refuses --prev-kv beside a range end, --prefix or --from-key: etcd would read every deleted pair with no limit and return them all in one answer. Delete without --prev-kv, or read the range with get first.",
      at(flags.get("prev-kv")?.word as Word),
    );
  return { kind: "del", ...range, prefix, fromKey, prevKv };
}

function buildWatch(input: BuildInput): EtcdCommand | CommandRefusal {
  const { flags, positionals } = input;
  const prefix = isSet(flags, "prefix");
  if (positionals.length === 2 && prefix)
    return refusal("conflicting-flags", "`range_end` and `--prefix` are mutually exclusive.", at(positionals[1]));
  // etcd sets an empty watch key to \x00 (v3rpc/watch.go), so a watch of '' would watch that one key
  // (measured on v3.7.2: etcdctl watch '' printed the put of the key \x00 and not the put of the key a).
  const range = keyAndRange(
    "watch",
    input,
    { prefix, fromKey: false },
    "since etcd would watch the key \\x00 alone: an empty key with --prefix watches every key",
  );
  if (isRefusal(range)) return range;
  const revision = flag(flags, "rev") as string | undefined;
  return {
    kind: "watch",
    ...range,
    prefix,
    ...(revision === undefined ? {} : { revision }),
    prevKv: isSet(flags, "prev-kv"),
  };
}

function noArguments(name: string, command: EtcdCommand): (input: BuildInput) => EtcdCommand | CommandRefusal {
  return (input) =>
    input.positionals.length > 0
      ? refusal("bad-argument", `${name} takes no arguments.`, at(input.positionals[0]))
      : command;
}

/** A command that takes exactly one argument, with the sentence that shows its usage. */
function oneArgument(name: string, usage: string, input: BuildInput): Word | CommandRefusal {
  const { positionals } = input;
  if (positionals.length === 1) return positionals[0];
  return refusal("bad-argument", `${name} needs ${usage}.`, at(positionals[1] ?? input.commandWord));
}

function leaseArgument(name: string, input: BuildInput): string | CommandRefusal {
  const word = oneArgument(name, `one lease id: ${name} <hex id>`, input);
  if (isRefusal(word)) return word;
  const id = leaseId(word.text);
  if (id.kind === "ok") return id.hex;
  const messages = {
    past: `${name}'s lease id is past the largest lease id, ${LARGEST_LEASE_ID}.`,
    signed: `${name} takes a lease id without a sign, ${UNSIGNED_LEASE}.`,
    "not-hex": `${name} takes a lease id in hexadecimal, as lease list prints it, such as 694d77aa9e38260f.`,
  };
  return refusal("bad-argument", messages[id.kind], at(word));
}

function buildLeaseGrant(input: BuildInput): EtcdCommand | CommandRefusal {
  const word = oneArgument("lease grant", "one TTL in seconds: lease grant <ttl>", input);
  if (isRefusal(word)) return word;
  const ttl = SIGNED_DECIMAL.test(word.text) ? Number(word.text) : Number.NaN;
  if (!(ttl >= 1))
    return refusal("bad-argument", "lease grant takes a TTL in whole seconds, 1 or more, such as 60.", at(word));
  if (ttl > Number.MAX_SAFE_INTEGER)
    return refusal(
      "bad-argument",
      `The TTL of lease grant is too large to send exactly; etcd grants at most ${MAX_LEASE_TTL} seconds.`,
      at(word),
    );
  return { kind: "lease-grant", ttlSeconds: ttl };
}

function withLease(
  name: string,
  make: (leaseHex: string, input: BuildInput) => EtcdCommand,
): (input: BuildInput) => EtcdCommand | CommandRefusal {
  return (input) => {
    const leaseHex = leaseArgument(name, input);
    return typeof leaseHex === "string" ? make(leaseHex, input) : leaseHex;
  };
}

function buildKeepAlive(input: BuildInput): EtcdCommand | CommandRefusal {
  if (!isSet(input.flags, "once"))
    return refusal(
      "bad-argument",
      "lease keep-alive needs --once: without it the keep-alive never ends, and Studio sends one exchange.",
      at(input.commandWord),
    );
  return withLease("lease keep-alive", (leaseHex) => ({ kind: "lease-keep-alive-once", leaseHex }))(input);
}

function withName(
  name: string,
  what: "user" | "role",
  usage: string,
  make: (value: string, input: BuildInput) => EtcdCommand,
): (input: BuildInput) => EtcdCommand | CommandRefusal {
  return (input) => {
    const word = oneArgument(name, `one ${what} name: ${usage}`, input);
    if (isRefusal(word)) return word;
    if (word.text === "") return refusal("bad-argument", `${name} needs a ${what} name that is not empty.`, at(word));
    return make(word.text, input);
  };
}

const COMMANDS: readonly CommandSpec[] = [
  {
    words: ["get"],
    kind: "get",
    arguments: "<key> [<range_end>]",
    flags: [
      boolean("prefix"),
      boolean("from-key"),
      LIMIT_FLAG,
      REV_FLAG,
      boolean("keys-only"),
      boolean("count-only"),
      CONSISTENCY_FLAG,
    ],
    refusedFlags: [
      { name: "sort-by", reason: WHOLE_RANGE },
      { name: "order", reason: WHOLE_RANGE },
      { name: "min-mod-rev", reason: WHOLE_RANGE },
      { name: "max-mod-rev", reason: WHOLE_RANGE },
      { name: "min-create-rev", reason: WHOLE_RANGE },
      { name: "max-create-rev", reason: WHOLE_RANGE },
      {
        name: "print-value-only",
        reason: "it shapes etcdctl's terminal output, and the result grid shows the value column",
      },
      {
        name: "stream",
        reason:
          "it calls the RangeStream RPC, which Studio does not call; the same command without it answers the same rows within the result's bounds",
      },
    ],
    dashExample: "get -- -key",
    build: buildGet,
  },
  {
    words: ["put"],
    kind: "put",
    arguments: "<key> <value>",
    flags: [LEASE_ID_FLAG, boolean("prev-kv"), boolean("ignore-value"), boolean("ignore-lease")],
    refusedFlags: [],
    dashExample: "put -- -key -value",
    build: buildPut,
  },
  {
    words: ["del"],
    kind: "del",
    arguments: "<key> [<range_end>]",
    flags: [boolean("prefix"), boolean("from-key"), boolean("prev-kv"), boolean("range")],
    refusedFlags: [],
    dashExample: "del -- -key",
    build: buildDel,
  },
  {
    words: ["txn"],
    kind: "txn",
    arguments: "",
    flags: [],
    refusedFlags: [
      {
        name: "interactive",
        shorthand: "i",
        reason: `${NO_TERMINAL}; write the compares and the requests on the lines below txn`,
      },
    ],
    build: (input) =>
      input.positionals.length > 0
        ? refusal(
            "bad-argument",
            "txn takes nothing on its line: write its compares and requests on the lines below it.",
            at(input.positionals[0]),
          )
        : { kind: "txn", compares: [], success: [], failure: [] },
  },
  {
    words: ["watch"],
    kind: "watch",
    arguments: "<key> [<range_end>]",
    flags: [boolean("prefix"), REV_FLAG, boolean("prev-kv")],
    refusedFlags: [
      { name: "interactive", shorthand: "i", reason: NO_TERMINAL },
      {
        name: "progress-notify",
        reason: "a watch in Studio is bounded and returns its events when its window closes, with no progress notices",
      },
    ],
    dashDashRunsProgram: true,
    build: buildWatch,
  },
  {
    words: ["lease", "grant"],
    kind: "lease-grant",
    arguments: "<ttl seconds>",
    flags: [],
    refusedFlags: [],
    build: buildLeaseGrant,
  },
  {
    words: ["lease", "revoke"],
    kind: "lease-revoke",
    arguments: "<hex id>",
    flags: [],
    refusedFlags: [],
    build: withLease("lease revoke", (leaseHex) => ({ kind: "lease-revoke", leaseHex })),
  },
  {
    words: ["lease", "timetolive"],
    kind: "lease-timetolive",
    arguments: "<hex id>",
    flags: [boolean("keys")],
    refusedFlags: [],
    build: withLease("lease timetolive", (leaseHex, input) => ({
      kind: "lease-timetolive",
      leaseHex,
      keys: isSet(input.flags, "keys"),
    })),
  },
  {
    words: ["lease", "list"],
    kind: "lease-list",
    arguments: "",
    flags: [],
    refusedFlags: [],
    build: noArguments("lease list", { kind: "lease-list" }),
  },
  {
    words: ["lease", "keep-alive"],
    kind: "lease-keep-alive-once",
    arguments: "<hex id>",
    flags: [boolean("once")],
    refusedFlags: [],
    build: buildKeepAlive,
  },
  {
    words: ["member", "list"],
    kind: "member-list",
    arguments: "",
    flags: [CONSISTENCY_FLAG],
    refusedFlags: [],
    build: (input) =>
      noArguments("member list", {
        kind: "member-list",
        consistency: (flag(input.flags, "consistency") ?? "l") as EtcdConsistency,
      })(input),
  },
  {
    words: ["endpoint", "status"],
    kind: "endpoint-status",
    arguments: "",
    flags: [],
    refusedFlags: [CLUSTER_FLAG],
    build: noArguments("endpoint status", { kind: "endpoint-status" }),
  },
  {
    words: ["endpoint", "health"],
    kind: "endpoint-health",
    arguments: "",
    flags: [],
    refusedFlags: [CLUSTER_FLAG],
    build: noArguments("endpoint health", { kind: "endpoint-health" }),
  },
  {
    words: ["alarm", "list"],
    kind: "alarm-list",
    arguments: "",
    flags: [],
    refusedFlags: [],
    build: noArguments("alarm list", { kind: "alarm-list" }),
  },
  {
    words: ["auth", "status"],
    kind: "auth-status",
    arguments: "",
    flags: [],
    refusedFlags: [],
    build: noArguments("auth status", { kind: "auth-status" }),
  },
  {
    words: ["user", "list"],
    kind: "user-list",
    arguments: "",
    flags: [],
    refusedFlags: [],
    build: noArguments("user list", { kind: "user-list" }),
  },
  {
    words: ["user", "get"],
    kind: "user-get",
    arguments: "<name>",
    flags: [boolean("detail")],
    refusedFlags: [],
    dashExample: "user get -- -name",
    build: withName("user get", "user", "user get <name> [--detail]", (name, input) => ({
      kind: "user-get",
      name,
      detail: isSet(input.flags, "detail"),
    })),
  },
  {
    words: ["role", "list"],
    kind: "role-list",
    arguments: "",
    flags: [],
    refusedFlags: [],
    build: noArguments("role list", { kind: "role-list" }),
  },
  {
    words: ["role", "get"],
    kind: "role-get",
    arguments: "<name>",
    flags: [],
    refusedFlags: [],
    dashExample: "role get -- -name",
    build: withName("role get", "role", "role get <name>", (name) => ({ kind: "role-get", name })),
  },
];

/** The commands and flags the subset takes, as data, for the provider doc and statementLanguage. */
export const ETCD_COMMAND_TABLE: ReadonlyArray<{
  readonly words: readonly string[];
  readonly kind: EtcdCommandKind;
  readonly arguments: string;
  readonly flags: readonly string[];
  readonly refusedFlags: ReadonlyArray<{ readonly flag: string; readonly shorthand?: string; readonly reason: string }>;
}> = COMMANDS.map((spec) => ({
  words: spec.words,
  kind: spec.kind,
  arguments: spec.arguments,
  flags: spec.flags.map((flag) => flag.display),
  refusedFlags: spec.refusedFlags.map((refused) => ({
    flag: `--${refused.name}`,
    ...(refused.shorthand === undefined ? {} : { shorthand: `-${refused.shorthand}` }),
    reason: refused.reason,
  })),
}));

type RefusedCommandCode = "maintenance-command" | "not-offered" | "blocking-command";

const maintenance = (words: string, card: string): string =>
  `${words} is a maintenance operation: an admin runs it from the ${card} card in the Global Operations section of Admin > Operations, which asks for a typed confirmation.`;
const notOffered = (words: string, reason: string): string => `${words} is not offered in this version: ${reason}.`;
const blocking = (word: string): string =>
  `${word} blocks until another client acts, and Studio holds no session for it.`;

const MEMBERSHIP = "Studio changes no cluster membership and moves no leader";
const ACCOUNTS = "Studio writes no users or roles; it reads them with user list, user get, role list and role get";
const INFO = "it prints etcdctl's own information, and the provider doc lists the commands Studio runs";

const refusedCommand = (
  words: readonly string[],
  code: RefusedCommandCode,
  sentence: (words: string) => string,
): { readonly words: readonly string[]; readonly code: RefusedCommandCode; readonly message: string } => ({
  words,
  code,
  message: sentence(words.join(" ")),
});

/** The commands 5.1.3 refuses by name, each with its whole sentence. */
export const ETCD_REFUSED_COMMANDS: ReadonlyArray<{
  readonly words: readonly string[];
  readonly code: RefusedCommandCode;
  readonly message: string;
}> = [
  refusedCommand(["compaction"], "maintenance-command", (w) => maintenance(w, "Compact history")),
  refusedCommand(["defrag"], "maintenance-command", (w) => maintenance(w, "Defragment")),
  refusedCommand(["alarm", "disarm"], "maintenance-command", (w) => maintenance(w, "Disarm alarms")),
  ...["add", "remove", "update", "promote"].map((sub) =>
    refusedCommand(["member", sub], "not-offered", (w) => notOffered(w, MEMBERSHIP)),
  ),
  refusedCommand(["move-leader"], "not-offered", (w) => notOffered(w, MEMBERSHIP)),
  refusedCommand(["snapshot", "save"], "not-offered", (w) =>
    notOffered(w, "Studio takes no snapshot, which etcdctl writes to a file on its own machine"),
  ),
  ...["validate", "enable", "cancel"].map((sub) =>
    refusedCommand(["downgrade", sub], "not-offered", (w) => notOffered(w, "Studio changes no cluster version")),
  ),
  ...["enable", "disable"].map((sub) =>
    refusedCommand(["auth", sub], "not-offered", (w) => notOffered(w, "Studio does not turn authentication on or off")),
  ),
  ...["add", "delete", "passwd", "grant-role", "revoke-role"].map((sub) =>
    refusedCommand(["user", sub], "not-offered", (w) => notOffered(w, ACCOUNTS)),
  ),
  ...["add", "delete", "grant-permission", "revoke-permission"].map((sub) =>
    refusedCommand(["role", sub], "not-offered", (w) => notOffered(w, ACCOUNTS)),
  ),
  refusedCommand(["lock"], "blocking-command", blocking),
  refusedCommand(["elect"], "blocking-command", blocking),
  refusedCommand(["make-mirror"], "not-offered", (w) => notOffered(w, "Studio copies no keys to another cluster")),
  ...["perf", "datascale"].map((sub) =>
    refusedCommand(["check", sub], "not-offered", (w) => notOffered(w, "Studio puts no test load on the cluster")),
  ),
  refusedCommand(["endpoint", "hashkv"], "not-offered", (w) => notOffered(w, "Studio reads no history hash")),
  ...["version", "completion", "options", "help"].map((word) =>
    refusedCommand([word], "not-offered", (w) => notOffered(w, INFO)),
  ),
];

const WHERE = "the connection, not the command, decides where Studio connects and as whom";
const CHANNEL = "the connection decides how Studio keeps its channel to etcd";
const BOUNDS = "Studio bounds every request and every answer itself";
const OUTPUT = "the result grid decides the output";

/** etcdctl v3.7.2's global flags (ctl.go) but --command-timeout, which the subset takes (spec 5.1.2). */
export const ETCD_REFUSED_GLOBAL_FLAGS: ReadonlyArray<{
  readonly flag: string;
  readonly shorthand?: string;
  readonly reason: string;
}> = [
  { flag: "--endpoints", reason: WHERE },
  { flag: "--user", reason: WHERE },
  { flag: "--password", reason: WHERE },
  { flag: "--cacert", reason: WHERE },
  { flag: "--cert", reason: WHERE },
  { flag: "--key", reason: WHERE },
  { flag: "--insecure-transport", reason: WHERE },
  { flag: "--insecure-skip-tls-verify", reason: WHERE },
  { flag: "--insecure-discovery", reason: WHERE },
  { flag: "--discovery-srv", shorthand: "-d", reason: WHERE },
  { flag: "--discovery-srv-name", reason: WHERE },
  { flag: "--dial-timeout", reason: CHANNEL },
  { flag: "--keepalive-time", reason: CHANNEL },
  { flag: "--keepalive-timeout", reason: CHANNEL },
  { flag: "--max-request-bytes", reason: BOUNDS },
  { flag: "--max-recv-bytes", reason: BOUNDS },
  { flag: "--auth-jwt-token", reason: WHERE },
  { flag: "--write-out", shorthand: "-w", reason: OUTPUT },
  { flag: "--hex", reason: OUTPUT },
  { flag: "--debug", reason: "it switches on etcdctl's own client logging, which Studio does not have" },
];

/** The one global flag the subset takes, as 5.1.2 writes it. */
export const ETCD_GLOBAL_FLAG = TIMEOUT_FLAG.display;

const HELP = "Studio prints no help, and the provider doc lists every command and flag";

// ============================================================================
// Flags, arguments and the command path
// ============================================================================

type FlagPlace =
  | { readonly where: "lead" }
  | { readonly where: "subcommand"; readonly group: string }
  | { readonly where: "command" | "request"; readonly spec: CommandSpec };

interface Found {
  readonly flags: Map<string, FlagOccurrence>;
  timeout?: { readonly ms: number; readonly word: Word };
}

const labelOf = (spec: CommandSpec): string => spec.words.join(" ");

/**
 * The flags etcdctl declares on a command group rather than on each of its subcommands, so that it
 * takes them between the group and its subcommand too: endpoint's --cluster (ep_command.go,
 * NewEndpointCommand). Each is refused there by name, with its reason.
 */
const GROUP_REFUSED_FLAGS: ReadonlyMap<string, readonly RefusedFlagSpec[]> = new Map([["endpoint", [CLUSTER_FLAG]]]);

interface RefusedScope {
  /** The command or the group the refusal names. */
  readonly subject: string;
  readonly flags: readonly RefusedFlagSpec[];
}

/** What a flag written at `place` belongs to, and the flags etcdctl has there that the subset refuses. */
function refusedScope(place: FlagPlace): RefusedScope | undefined {
  if (place.where === "command" || place.where === "request")
    return { subject: labelOf(place.spec), flags: place.spec.refusedFlags };
  if (place.where === "subcommand") return { subject: place.group, flags: GROUP_REFUSED_FLAGS.get(place.group) ?? [] };
  return undefined;
}

/** The long name a shorthand stands for where it is written, or undefined when none does. */
function shorthandName(letter: string, place: FlagPlace): string | undefined {
  if (place.where === "command" || place.where === "request") {
    const own = place.spec.refusedFlags.find((refused) => refused.shorthand === letter);
    if (own !== undefined) return own.name;
  }
  if (letter === "h") return "help";
  return ETCD_REFUSED_GLOBAL_FLAGS.find((global) => global.shorthand === `-${letter}`)?.flag.slice(2);
}

/**
 * etcdctl takes a command's own flag before the command word or its subcommand when it is written with
 * `=` (measured on v3.7.2: --prefix=true get /a/ read both keys), and misreads it without (--prefix
 * get /a/ answered unknown command "/a/"), so Studio takes one place for it in both spellings.
 */
function unknownFlag(shown: string, place: FlagPlace, word: Word): CommandRefusal {
  if (place.where === "lead")
    return refusal(
      "unknown-flag",
      `${shown} comes before the command word, and Studio takes a command's own flags only after the command and its subcommand: write it after them.`,
      at(word),
    );
  if (place.where === "subcommand")
    return refusal(
      "unknown-flag",
      `${shown} comes between ${place.group} and its subcommand, and Studio takes a command's own flags only after both: write it after ${place.group} and its subcommand.`,
      at(word),
    );
  const label = labelOf(place.spec);
  const displays = place.spec.flags.map((spec) => spec.display);
  const takes =
    displays.length === 0
      ? "it takes no flags"
      : displays.length === 1
        ? `the flag ${label} takes is ${displays[0]}`
        : `the flags ${label} takes are ${joinWith(displays, "and")}`;
  const advice =
    place.spec.dashExample === undefined
      ? ""
      : ` A word that begins with - and is not a flag is written after --, as in ${place.spec.dashExample}.`;
  return refusal("unknown-flag", `${label} has no flag ${shown}: ${takes}.${advice}`, at(word));
}

/**
 * Reads the flag word at `index` as pflag does, and answers the index of the word after it, or
 * the refusal. The command's own flags come first, then --command-timeout, then etcdctl's other
 * global flags, which are refused, then --help, then anything else, which is unknown.
 */
function readFlag(words: readonly Word[], index: number, place: FlagPlace, found: Found): number | CommandRefusal {
  const word = words[index];
  const text = word.text;
  let name: string | undefined;
  let inline: string | undefined;
  if (text.startsWith("--")) {
    const body = text.slice(2);
    const equals = body.indexOf("=");
    name = equals < 0 ? body : body.slice(0, equals);
    inline = equals < 0 ? undefined : body.slice(equals + 1);
    if (name === "" || name.startsWith("-")) name = undefined;
  } else {
    name = shorthandName(text[1], place);
  }
  const shown = named(text);
  if (name === undefined) return unknownFlag(shown, place, word);

  const spec = place.where === "command" || place.where === "request" ? place.spec : undefined;
  const own = spec?.flags.find((candidate) => candidate.name === name);
  const scope = refusedScope(place);
  const refusedOwn = scope?.flags.find((candidate) => candidate.name === name);
  if (refusedOwn !== undefined)
    return refusal(
      "refused-flag",
      `${(scope as RefusedScope).subject} does not take --${name}: ${refusedOwn.reason}.`,
      at(word),
    );
  const isTimeout = own === undefined && name === TIMEOUT_FLAG.name;
  if (isTimeout && place.where === "request")
    return refusal(
      "global-flag",
      "--command-timeout is a flag of the txn line, not of a request in its body: write it on the txn line.",
      at(word),
    );
  if (own === undefined && !isTimeout) {
    const global = ETCD_REFUSED_GLOBAL_FLAGS.find((candidate) => candidate.flag === `--${name}`);
    if (global !== undefined)
      return refusal(
        "global-flag",
        `The global flag ${global.flag} is refused: ${global.reason}. The one global flag a command takes is --command-timeout.`,
        at(word),
      );
    if (name === "help") {
      const message =
        scope === undefined ? `--help is refused: ${HELP}.` : `${scope.subject} does not take --help: ${HELP}.`;
      return refusal("refused-flag", message, at(word));
    }
    return unknownFlag(shown, place, word);
  }

  const flagSpec = own ?? TIMEOUT_FLAG;
  let next = index + 1;
  let value: FlagValue;
  if (flagSpec.takes === "boolean") {
    const read = inline === undefined ? true : PARSE_BOOL.get(inline);
    if (read === undefined)
      return refusal("bad-argument", `--${name} takes true or false, as in --${name}=true.`, at(word));
    value = read;
  } else {
    const raw = inline ?? words[index + 1]?.text;
    if (raw === undefined)
      return refusal("bad-argument", `--${name} needs a value, as in --${name}=${flagSpec.example}.`, at(word));
    if (inline === undefined) next += 1;
    const parsed = (flagSpec.parse as (text: string) => ValueParse)(raw);
    if ("message" in parsed) return refusal("bad-argument", parsed.message, at(word));
    value = parsed.value;
    if (isTimeout) {
      if (found.timeout !== undefined)
        return refusal("conflicting-flags", "--command-timeout is given twice: give it once.", at(word));
      found.timeout = { ms: value as number, word };
      return next;
    }
  }
  if (found.flags.has(name)) return refusal("conflicting-flags", `--${name} is given twice: give it once.`, at(word));
  found.flags.set(name, { value, word });
  return next;
}

/** A command's flags and positionals, read as pflag reads them, with `--` ending the flags. */
function readArguments(
  words: readonly Word[],
  from: number,
  place: { readonly where: "command" | "request"; readonly spec: CommandSpec },
  found: Found,
): Word[] | CommandRefusal {
  const positionals: Word[] = [];
  let flagsEnded = false;
  for (let index = from; index < words.length; index++) {
    const word = words[index];
    if (flagsEnded || !isFlagText(word.text)) {
      positionals.push(word);
    } else if (word.text === "--") {
      if (place.spec.dashDashRunsProgram === true)
        return refusal(
          "bad-argument",
          "watch runs no program: Studio refuses -- and the command after it, which etcdctl runs for each event.",
          at(word),
        );
      flagsEnded = true;
    } else {
      const next = readFlag(words, index, place, found);
      if (typeof next !== "number") return next;
      index = next - 1;
    }
  }
  return positionals;
}

const COMMAND_LIST = joinWith(
  COMMANDS.map((spec) => labelOf(spec)),
  "and",
);
const GROUPS: ReadonlySet<string> = new Set(
  [...COMMANDS.map((spec) => spec.words), ...ETCD_REFUSED_COMMANDS.map((entry) => entry.words)]
    .filter((words) => words.length === 2)
    .map((words) => words[0]),
);

const unknownCommand = (shown: string, word: Word): CommandRefusal =>
  refusal(
    "unknown-command",
    `${shown} is not an etcdctl command Studio runs. The commands are ${COMMAND_LIST}.`,
    at(word),
  );

/** The command a text names, from its command word and, for a group, its subcommand (spec 5.1.3). */
function resolveCommand(
  words: readonly Word[],
  index: number,
  found: Found,
): { readonly spec: CommandSpec; readonly next: number } | CommandRefusal {
  const first = words[index];
  const matches = (candidate: readonly string[], path: readonly string[]) =>
    candidate.length === path.length && candidate.every((part, position) => part === path[position]);
  const lookUp = (path: readonly string[], word: Word, next: number) => {
    const spec = COMMANDS.find((candidate) => matches(candidate.words, path));
    if (spec !== undefined) return { spec, next };
    const refused = ETCD_REFUSED_COMMANDS.find((candidate) => matches(candidate.words, path));
    return refused === undefined ? undefined : refusal(refused.code, refused.message, at(word));
  };
  if (!GROUPS.has(first.text))
    return lookUp([first.text], first, index + 1) ?? unknownCommand(named(first.text), first);

  // A group: the subcommand is the next word that is not a flag, and only --command-timeout may come between.
  const group = first.text;
  let sub = index + 1;
  while (sub < words.length && isFlagText(words[sub].text)) {
    const next = readFlag(words, sub, { where: "subcommand", group }, found);
    if (typeof next !== "number") return next;
    sub = next;
  }
  const runs = COMMANDS.filter((spec) => spec.words[0] === group).map((spec) => spec.words[1]);
  if (sub >= words.length) {
    const message =
      runs.length === 0
        ? `${group} needs a subcommand, and Studio runs none of its subcommands.`
        : `${group} needs a subcommand: ${joinWith(runs, "or")}.`;
    return refusal("unknown-command", message, at(first));
  }
  const subWord = words[sub];
  const match = lookUp([group, subWord.text], first, sub + 1);
  if (match !== undefined) return match;
  if (runs.length === 0) return unknownCommand(`${group} ${named(subWord.text)}`, subWord);
  const listed =
    runs.length === 1
      ? `the ${group} subcommand is ${runs[0]}`
      : `the ${group} subcommands are ${joinWith(runs, "and")}`;
  return refusal(
    "unknown-command",
    `${group} has no subcommand ${named(subWord.text)} that Studio runs: ${listed}.`,
    at(subWord),
  );
}

// ============================================================================
// The txn body (spec 5.1.4)
// ============================================================================

const TARGETS: ReadonlyMap<string, TxnCompareSpec["target"]> = new Map([
  ["c", "create"],
  ["create", "create"],
  ["m", "mod"],
  ["mod", "mod"],
  ["ver", "version"],
  ["version", "version"],
  ["val", "value"],
  ["value", "value"],
  ["lease", "lease"],
]);
const OPERATORS: ReadonlySet<string> = new Set(["=", "!=", "<", ">"]);
const REQUESTS: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.filter((spec) => ["get", "put", "del"].includes(spec.kind)).map((spec) => [spec.words[0], spec]),
);

function readCompareLine(line: SplitLine): TxnCompareSpec | CommandRefusal {
  const parts = line.compare as NonNullable<SplitLine["compare"]>;
  const where = `Line ${line.line} of the txn`;
  const target = TARGETS.get(parts.target.text);
  if (target === undefined)
    return refusal(
      "txn-syntax",
      `${where} compares ${bounded(parts.target.text)}, which is no target: the targets are create (c), mod (m), version (ver), value (val) and lease.`,
      at(parts.target),
    );
  if (parts.key.bytes.length === 0)
    return refusal("txn-syntax", `${where} compares an empty key: etcd answers "key is not provided".`, at(parts.key));
  if (!OPERATORS.has(parts.operator.text))
    return refusal(
      "txn-syntax",
      `${where} compares with ${bounded(parts.operator.text)}, which is no operator: the operators are =, !=, < and >.`,
      at(parts.operator),
    );
  const operator = parts.operator.text as TxnCompareOperator;
  let spec: TxnCompareSpec;
  if (target === "value") {
    spec = { target, key: parts.key.bytes, operator, operand: parts.value.bytes };
  } else if (target === "lease") {
    const id = leaseId(parts.value.text);
    if (id.kind === "signed")
      return refusal(
        "txn-syntax",
        `${where} compares lease with a signed id: write the id without a sign, as lease list prints the ids etcd grants, or "0" for a key with no lease. ${NEGATIVE_LEASE}.`,
        at(parts.value),
      );
    if (id.kind !== "ok")
      return refusal(
        "txn-syntax",
        `${where} compares lease with a value that is not a hexadecimal lease id: write the id as lease list prints it, or "0" for a key with no lease.`,
        at(parts.value),
      );
    spec = { target, key: parts.key.bytes, operator, operand: id.hex };
  } else {
    const decimal = signedInt64(parts.value.text);
    const what = target === "version" ? "version" : "revision";
    if (decimal === undefined)
      return refusal(
        "txn-syntax",
        `${where} compares ${target} with a value that is not a decimal ${what}: write a whole number, as in ${target}("key1") > "0".`,
        at(parts.value),
      );
    spec = { target, key: parts.key.bytes, operator, operand: decimal };
  }
  if (parts.rest !== "")
    return refusal("txn-syntax", `${where} has text after the compared value, which etcdctl ignores: remove it.`, {
      line: line.line,
      column: parts.value.endColumn,
    });
  return spec;
}

function readRequestLine(line: SplitLine, limits: EtcdParseLimits): TxnRequestSpec | CommandRefusal {
  const words = line.words as readonly Word[];
  const first = words[0];
  const spec = REQUESTS.get(first.text);
  if (spec === undefined)
    return refusal(
      "txn-syntax",
      `Line ${line.line} of the txn requests ${named(first.text)}, which a txn does not take: a request is get, put or del.`,
      at(first),
    );
  const found: Found = { flags: new Map() };
  const positionals = readArguments(words, 1, { where: "request", spec }, found);
  if (isRefusal(positionals)) return positionals;
  return spec.build({ commandWord: first, positionals, flags: found.flags, limits, inTxn: true }) as
    | TxnRequestSpec
    | CommandRefusal;
}

/**
 * Whether the run of `#` lines starting at `index` is one spec 5.1.4 removes: a run directly above a
 * compare or a request, or one followed only by `#` and empty lines.
 */
function commentRunRemovable(body: readonly SplitLine[], index: number): boolean {
  let next = index;
  while (next < body.length && body[next].role === "comment") next += 1;
  if (next >= body.length || body[next].role !== "blank") return true;
  return body.slice(next).every((line) => line.role === "blank" || line.role === "comment");
}

function readTxnBody(lines: readonly SplitLine[], limits: EtcdParseLimits): EtcdCommand | CommandRefusal {
  const body = lines.filter((line) => line.section !== "command");
  const compares: TxnCompareSpec[] = [];
  const branches = {
    success: { requests: [] as TxnRequestSpec[], first: undefined as SplitLine | undefined },
    failure: { requests: [] as TxnRequestSpec[], first: undefined as SplitLine | undefined },
  };
  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    const place = { line: line.line, column: line.start };
    if (line.refusal !== undefined) return line.refusal;
    if (line.role === "compare") {
      const spec = readCompareLine(line);
      if (isRefusal(spec)) return spec;
      compares.push(spec);
    } else if (line.role === "request") {
      const spec = readRequestLine(line, limits);
      if (isRefusal(spec)) return spec;
      const branch = branches[line.section as "success" | "failure"];
      branch.first ??= line;
      branch.requests.push(spec);
    } else if (line.role === "content") {
      return refusal(
        "txn-syntax",
        `Line ${line.line} comes after the txn's failure list, which the third empty line ended, and etcdctl never reads it: remove the line, or an empty line above it.`,
        place,
      );
    } else if (line.role === "comment" && body[index - 1]?.role !== "comment" && !commentRunRemovable(body, index)) {
      return refusal(
        "txn-syntax",
        `Line ${line.line} of the txn is a # line that is neither directly above a compare or a request nor followed only by # and empty lines, and a # line above an empty line could read as a list of its own: move it directly above a compare or a request, or remove it.`,
        place,
      );
    }
  }
  // The rows of 5.2 a branch could answer: the succeeded row, each get at its limit, one per other request.
  for (const name of ["success", "failure"] as const) {
    const { requests, first } = branches[name];
    const rows = requests.reduce((sum, request) => {
      const ranged = request.kind === "get" && (request.rangeEnd !== undefined || request.prefix || request.fromKey);
      return sum + (ranged && !request.countOnly ? (request.limit ?? limits.txnRangeLimit) : 1);
    }, 1);
    if (rows > limits.maxLimit)
      return refusal(
        "limit-too-large",
        `The ${name} list of the txn could answer ${rows} rows, above the ${limits.maxLimit} a result holds, counting the succeeded row, each get at its limit (a single-key get as one row, a ranged get with no --limit as ${limits.txnRangeLimit}) and one row for each other request: lower the limits, or split the txn.`,
        { line: (first as SplitLine).line, column: (first as SplitLine).start },
      );
  }
  return { kind: "txn", compares, success: branches.success.requests, failure: branches.failure.requests };
}

// ============================================================================
// The whole text (spec 5.1.2)
// ============================================================================

const EMPTY = "The editor holds no etcd command: write one, such as get /app/ --prefix.";

/** The first word of a line the lexer did not read, as a refusal may name it. */
function firstWordOf(line: SplitLine): string {
  const rest = line.text.slice(line.start);
  const blank = rest.search(/[ \t]/);
  return named(blank < 0 ? rest : rest.slice(0, blank));
}

/**
 * Parses editor text to one etcdctl command (spec 5.1). Blank and comment lines before the command
 * are skipped, and so are those after it; the leading tokens of a documented command are dropped;
 * `txn` takes the rest of the text as its body; and any other command followed by another line is
 * refused, naming that line.
 */
export function parseEtcdCommand(text: string, limits: EtcdParseLimits): ParseResult {
  const read = splitWords(text);
  if (!read.ok) return { ok: false, refusal: read.refusal };
  const { command: words, lead, lines } = read.split;
  const fail = (refused: CommandRefusal): ParseResult => ({ ok: false, refusal: refused });
  const found: Found = { flags: new Map() };

  for (let index = 0; index < lead.commandIndex; index++) {
    const role = lead.roles[index];
    const word = words[index];
    if (role === "assignment" && word.text !== "ETCDCTL_API=3")
      return fail(
        refusal(
          "global-flag",
          `The environment variable ${named(word.text)} is refused: before a command Studio accepts only ETCDCTL_API=3, because ${WHERE}.`,
          at(word),
        ),
      );
    if (role === "flag") {
      const next = readFlag(words, index, { where: "lead" }, found);
      if (typeof next !== "number") return fail(next);
      index = next - 1;
    }
  }
  if (lead.commandIndex >= words.length) return fail(refusal("empty", EMPTY));

  const resolved = resolveCommand(words, lead.commandIndex, found);
  if (isRefusal(resolved)) return fail(resolved);
  const { spec, next } = resolved;
  const positionals = readArguments(words, next, { where: "command", spec }, found);
  if (isRefusal(positionals)) return fail(positionals);
  const commandWord = words[lead.commandIndex];
  let command = spec.build({ commandWord, positionals, flags: found.flags, limits, inTxn: false });
  if (isRefusal(command)) return fail(command);

  if (command.kind === "txn") {
    command = readTxnBody(lines, limits);
    if (isRefusal(command)) return fail(command);
  } else {
    const second = lines.find((line) => line.role === "content");
    if (second !== undefined)
      return fail(
        refusal(
          "second-command",
          `Line ${second.line} holds a second command, which begins with ${firstWordOf(second)}: Studio runs one command per run. Select the line to run it, and the editor sends the selection.`,
          { line: second.line, column: second.start },
        ),
      );
  }

  const timeout = found.timeout;
  if (timeout !== undefined) {
    const isWatch = command.kind === "watch";
    const cap = isWatch ? limits.maxWatchWindowMs : limits.maxCommandTimeoutMs;
    if (timeout.ms > cap) {
      const message = isWatch
        ? `--command-timeout sets the watch window, which is at most ${formatMs(cap)} on this connection, its query timeout less the time a watch needs to return its events: lower it, or raise Query Timeout in the connection's settings.`
        : `--command-timeout is above this connection's query timeout, ${formatMs(cap)}: lower it, or raise Query Timeout in the connection's settings.`;
      return fail(refusal("limit-too-large", message, at(timeout.word)));
    }
  }
  const parsed: ParsedCommand = {
    command,
    line: commandWord.line,
    ...(timeout === undefined ? {} : { commandTimeoutMs: timeout.ms }),
  };
  return { ok: true, parsed };
}
