/**
 * What an etcd command is (spec 3.1, 5.1.3, 5.5): its class, its destructive class, the Gate of 5.1.3,
 * the text or the targets its typed confirmation asks for, its single-key write targets and every
 * range it writes.
 *
 * Pure, and shipped to the browser: `src/lib/db/destructive-commands.ts` reads it for the
 * confirmation gate and `write-policy.ts` reads the same assessment on the server, so what asks and
 * what runs are one parse of one text (spec 5.5). It classifies and decides nothing about E6's
 * read-only mode or E8's protected set, which are write-policy.ts's (R13 A6).
 */
import type { EtcdByteRange, EtcdBytes } from "./client";
import {
  ETCD_COMMAND_TABLE,
  type EtcdCommand,
  type EtcdCommandKind,
  type EtcdParseLimits,
  parseEtcdCommand,
  type TxnRequestSpec,
} from "./commands";
import { commandRange, compareBytes, type KeyQuoting, keySpan, typedKey } from "./keys";

export type CommandClass = "read" | "write";

/** The Gate column of spec 5.1.3: what the confirmation gate asks before the command runs. */
export type CommandGate = "none" | "one-click" | "typed";

/**
 * What the typed confirmation asks for (spec 5.5): structurally `TypedConfirmationAsk` of
 * `src/lib/db/types.ts`, which the vocabulary row assigns it to; this file does not import it.
 */
export type EtcdTypedConfirmation =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "connection-name"; readonly targets: readonly string[] };

export interface CommandAssessment {
  readonly class: CommandClass;
  /**
   * Spec 5.1.3's "write, destructive": a del with a range end, --prefix or --from-key, a lease revoke,
   * and a txn holding such a del.
   */
  readonly destructive: boolean;
  readonly gate: CommandGate;
  /**
   * Only with gate "typed" (spec 5.5): the prefix, start key or lease id, or the connection's name
   * with every target.
   */
  readonly typedConfirmation?: EtcdTypedConfirmation;
  /** E8's single-key write targets, deduplicated, in the order written, both txn branches included. */
  readonly singleKeyTargets: readonly EtcdBytes[];
  /** Every range the command writes, for E8's prefix check. */
  readonly writeRanges: readonly EtcdByteRange[];
  /**
   * The names NON_SQL_DESTRUCTIVE_VOCABULARY's reader answers (spec 5.5): the command's words, and a
   * txn's request words after "txn".
   */
  readonly operations: readonly string[];
}

/**
 * The names the gate asks about (spec 5.5): the writes that change or remove keys, and the lease
 * revoke that deletes them.
 */
export const ETCD_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set(["put", "del", "lease revoke"]);

/** What a whole-key-space delete lists as its target (spec 5.5, R13 D2). */
const EVERY_KEY = "every key";

/** The command's words as etcdctl spells them, from the grammar's own table, so no second list of names exists. */
const COMMAND_WORDS: ReadonlyMap<EtcdCommandKind, string> = new Map(
  ETCD_COMMAND_TABLE.map((entry) => [entry.kind, entry.words.join(" ")]),
);

const wordsOf = (kind: EtcdCommandKind): string => COMMAND_WORDS.get(kind) as string;

type PutSpec = Extract<TxnRequestSpec, { readonly kind: "put" }>;
type DelSpec = Extract<TxnRequestSpec, { readonly kind: "del" }>;

/** A del that names more than one key: a range end, --prefix or --from-key (spec 5.1.3, 5.5). */
function namesRange(del: DelSpec): boolean {
  return del.rangeEnd !== undefined || del.prefix || del.fromKey;
}

/**
 * A delete of every key (spec 5.1.3, 5.5): the empty key with --prefix or --from-key, as etcdctl
 * sends it, or any range that begins at 0x00, the smallest key, and runs to the end.
 */
function isWholeKeySpace(del: DelSpec): boolean {
  const span = keySpan(commandRange(del));
  return span.end === undefined && compareBytes(span.begin, Uint8Array.of(0)) <= 0;
}

/** A destructive target as the dialog lists it (spec 5.5): the typed key and how the range was written. */
function targetOf(del: DelSpec, quoting: KeyQuoting): string {
  if (isWholeKeySpace(del)) return EVERY_KEY;
  const start = typedKey(del.key, quoting);
  if (del.prefix) return `${start} (prefix)`;
  if (del.fromKey) return `${start} (from key)`;
  return `${start} to ${typedKey(del.rangeEnd as EtcdBytes, quoting)} (range)`;
}

/** The typed confirmation of one destructive target, or of several (spec 5.5, R13 D2). */
function confirmationFor(targets: readonly DelSpec[], quoting: KeyQuoting): EtcdTypedConfirmation {
  if (targets.length === 1 && !isWholeKeySpace(targets[0]))
    return { type: "text", text: typedKey(targets[0].key, quoting) };
  return { type: "connection-name", targets: targets.map((target) => targetOf(target, quoting)) };
}

const sameBytes = (a: EtcdBytes | undefined, b: EtcdBytes | undefined): boolean =>
  a === undefined || b === undefined ? a === b : compareBytes(a, b) === 0;

/** The keys in the order first written, each once. */
function uniqueKeys(keys: readonly EtcdBytes[]): EtcdBytes[] {
  return keys.filter((key, index) => keys.findIndex((other) => compareBytes(other, key) === 0) === index);
}

/** The deletes in the order first written, each range once, whichever spelling named it. */
function uniqueRanges(deletes: readonly DelSpec[]): DelSpec[] {
  const ranges = deletes.map(commandRange);
  return deletes.filter(
    (_del, index) =>
      ranges.findIndex(
        (other) => sameBytes(other.key, ranges[index].key) && sameBytes(other.rangeEnd, ranges[index].rangeEnd),
      ) === index,
  );
}

const readOf = (kind: EtcdCommandKind): CommandAssessment => ({
  class: "read",
  destructive: false,
  gate: "none",
  singleKeyTargets: [],
  writeRanges: [],
  operations: [wordsOf(kind)],
});

function assessTxn(command: Extract<EtcdCommand, { readonly kind: "txn" }>): CommandAssessment {
  const requests = [...command.success, ...command.failure];
  const operations = [...new Set(["txn", ...requests.map((request) => wordsOf(request.kind))])];
  const writes = requests.filter((request): request is PutSpec | DelSpec => request.kind !== "get");
  if (writes.length === 0) return { ...readOf("txn"), operations };
  const singleKeyTargets = uniqueKeys(
    writes.filter((request) => request.kind === "put" || !namesRange(request)).map((request) => request.key),
  );
  const writeRanges = writes.map((request) => (request.kind === "put" ? { key: request.key } : commandRange(request)));
  const destructive = uniqueRanges(
    writes.filter((request): request is DelSpec => request.kind === "del" && namesRange(request)),
  );
  if (destructive.length === 0) {
    return { class: "write", destructive: false, gate: "one-click", singleKeyTargets, writeRanges, operations };
  }
  return {
    class: "write",
    destructive: true,
    gate: "typed",
    typedConfirmation: confirmationFor(destructive, "txn"),
    singleKeyTargets,
    writeRanges,
    operations,
  };
}

/** One command's classification, each row of 5.1.3's Class and Gate columns (spec 5.1.3, 5.5). */
export function assessCommand(command: EtcdCommand): CommandAssessment {
  switch (command.kind) {
    case "put":
      return {
        class: "write",
        destructive: false,
        gate: "one-click",
        singleKeyTargets: [command.key],
        writeRanges: [{ key: command.key }],
        operations: [wordsOf("put")],
      };
    case "del": {
      const writeRanges = [commandRange(command)];
      const operations = [wordsOf("del")];
      if (!namesRange(command)) {
        return {
          class: "write",
          destructive: false,
          gate: "one-click",
          singleKeyTargets: [command.key],
          writeRanges,
          operations,
        };
      }
      const typedConfirmation = confirmationFor([command], "command-line");
      return {
        class: "write",
        destructive: true,
        gate: "typed",
        typedConfirmation,
        singleKeyTargets: [],
        writeRanges,
        operations,
      };
    }
    case "txn":
      return assessTxn(command);
    case "lease-grant":
    case "lease-keep-alive-once":
      // They destroy nothing, so they ask nothing (spec 5.5, section 15), and E6 still refuses both.
      return { ...readOf(command.kind), class: "write" };
    case "lease-revoke":
      return {
        class: "write",
        destructive: true,
        gate: "typed",
        typedConfirmation: { type: "text", text: command.leaseHex },
        singleKeyTargets: [],
        writeRanges: [],
        operations: [wordsOf("lease-revoke")],
      };
    default:
      return readOf(command.kind);
  }
}

/** The confirmation gate has no connection, so it parses with no cap it cannot know (C2's EtcdParseLimits). */
const GATE_LIMITS: EtcdParseLimits = {
  maxLimit: Number.POSITIVE_INFINITY,
  txnRangeLimit: Number.POSITIVE_INFINITY,
  maxCommandTimeoutMs: Number.POSITIVE_INFINITY,
  maxWatchWindowMs: Number.POSITIVE_INFINITY,
};

/**
 * The vocabulary's reader (spec 5.5): the operations the text names. Text the parser refuses
 * names none, because it will not run, so it asks nothing; this reader never answers undefined,
 * which the shared gate would turn into a prompt.
 */
export function readEtcdOperations(text: string): readonly string[] | undefined {
  const parsed = parseEtcdCommand(text, GATE_LIMITS);
  return parsed.ok ? assessCommand(parsed.parsed.command).operations : [];
}

/** The vocabulary's typedConfirmation (spec 3.4, 5.5): undefined for text that does not parse or asks no typed text. */
export function etcdTypedConfirmation(text: string): EtcdTypedConfirmation | undefined {
  const parsed = parseEtcdCommand(text, GATE_LIMITS);
  return parsed.ok ? assessCommand(parsed.parsed.command).typedConfirmation : undefined;
}
