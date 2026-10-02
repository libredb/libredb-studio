/**
 * Runs one parsed etcdctl command within the bounds of spec 5.4, through the slice of the seam it
 * calls (spec 3.1, 3.5).
 *
 * Nothing is sent before write-policy.ts has decided E6's read-only mode and E8's protected
 * prefixes and key from guard.ts's classification. What E8 decides from the key space itself is
 * read next, as reads, and handed to write-policy.ts: the stored values of a write's single-key
 * targets, in one Range or in read-only Txns of at most 128 Range ops, and a lease's keys, from
 * LeaseTimeToLive with keys: true. A top-level single-key put or del that passes is sent as E8's
 * guarded Txn: a compare of mod on the revision the read found, the command's own op on success,
 * and one Range of the key on failure, so a key that changed after the read is refused with
 * nothing written, and kine accepts the shape (spec 8). A typed txn is sent as written after its
 * read, which is not atomic with it (spec E17).
 *
 * A get reads in pages pinned to its first page's revision (spec 5.4, E14): the first page asks
 * for P keys, and a later page for twice as many, up to the ceiling, while two of the page just
 * read still fit in the byte budget left. A watch is watch.ts's bounded loop, and every other
 * command is its one call, or etcdctl's two for endpoint health. A list etcd answers whole (the
 * leases, a lease's keys, the users, the roles, and a user's or a role's permissions) holds its first
 * rowLimit entries and says how many etcd answered, since only the receive cap bounds it on the wire
 * (spec 5.4). A --command-timeout is the deadline of the whole command, its calls together, and a
 * watch's window instead (spec 5.1.2).
 *
 * Every failure passes through errors.ts with `write` from guard.ts's class (spec 5.6), and a
 * request read before a write is mapped as a read, since no write left the client. The sentences
 * worded here are the outcomes only this module sees: a guarded Txn whose compare failed, a
 * compaction that overtook a read between its pages (plan Review Focus 2), a page that cannot move
 * the read on, and a query timeout that leaves a watch no window (KE5); and two refusals of a command
 * a caller built past the parser's bounds: a watch window above its cap, and a lease id that is not
 * hexadecimal.
 */
import { QueryError } from "@/lib/db/errors";
import type { DatabaseType } from "@/lib/db/types";
import {
  type EtcdAlarm,
  type EtcdByteRange,
  type EtcdBytes,
  type EtcdCallOptions,
  type EtcdClient,
  type EtcdCompare,
  type EtcdCompareResult,
  type EtcdDeleteRangeRequest,
  EtcdError,
  type EtcdInt64,
  type EtcdKeyValue,
  type EtcdLeaseTimeToLiveResponse,
  type EtcdPutRequest,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
  type EtcdRequestOp,
  type EtcdResponseOp,
  type EtcdTxnRequest,
  type EtcdTxnResponse,
  type EtcdWatchRequest,
} from "./client";
import {
  ETCD_COMMAND_TABLE,
  type EtcdCommand,
  type ParsedCommand,
  type TxnCompareOperator,
  type TxnCompareSpec,
  type TxnRequestSpec,
} from "./commands";
import {
  type EtcdErrorConnection,
  type EtcdErrorContext,
  leaseNotFoundError,
  toEtcdError,
  toProviderError,
} from "./errors";
import { assessCommand } from "./guard";
import { commandRange, fromHexId } from "./keys";
import { describeRange } from "./permissions";
import type { CommandOutcome, ReadStop, WatchOutcome } from "./results";
import { runBoundedWatch } from "./watch";
import {
  type PolicyRefusal,
  type ReadOnlySource,
  refuseBeforeSend,
  refuseLeaseRevoke,
  refuseStoredValues,
} from "./write-policy";

const PROVIDER: DatabaseType = "etcd";

export type EtcdExecuteClient = Pick<
  EtcdClient,
  | "range"
  | "deleteRange"
  | "txn"
  | "watch"
  | "leaseGrant"
  | "leaseRevoke"
  | "leaseKeepAliveOnce"
  | "leaseTimeToLive"
  | "leaseLeases"
  | "memberList"
  | "status"
  | "alarmList"
  | "authStatus"
  | "userList"
  | "userGet"
  | "roleList"
  | "roleGet"
>;

export interface ExecutionBounds {
  /** The most rows a result holds: DEFAULT_QUERY_LIMIT, 500 (spec 5.4). */
  readonly rowLimit: number;
  /** P: a get's first page, and the limit a ranged get inside a txn is sent with (spec 5.1.4, KE4). */
  readonly firstPageSize: number;
  /** The ceiling a get's page size grows to (KE4). */
  readonly maxPageSize: number;
  /**
   * B: the bytes of the keys and values a get or a watch holds; a txn's reads are bounded in its request instead
   * (spec 5.1.4, 5.4, KE4).
   */
  readonly byteBudget: number;
  /** C: the characters one cell holds, which results.ts cuts at (spec 5.2, KE4). */
  readonly cellLimit: number;
  /** The time a watch at its cap keeps, before the query timeout ends its call, to return its events (spec 5.3, KE5). */
  readonly watchMarginMs: number;
  /** The connection's query timeout, the deadline on every call (spec 5.3). */
  readonly queryTimeoutMs: number;
}

/**
 * KE4's and KE5's bounds: Kafka's measured 8 MiB result budget and 64 KiB cell bound (spec 5.4), and
 * the 1 s margin spec 5.3's example implies (a 5 s query timeout caps a watch at 4 s). Each was kept
 * by Task 22's measurement on the KE1 fixture on 2026-10-01 (KE4: gets of 1 MiB and of 64 KiB values
 * stopped at B with 7 and 127 rows in 99 and 48 ms; KE5: watches under a 5 s and a 2 s query timeout
 * returned at most 11 ms past their cap, and one under a 1 s query timeout was refused at once).
 */
export const ETCD_READ_BOUNDS: Omit<ExecutionBounds, "rowLimit" | "queryTimeoutMs"> = {
  firstPageSize: 100,
  maxPageSize: 500,
  byteBudget: 8 * 1024 * 1024,
  cellLimit: 64 * 1024,
  watchMarginMs: 1_000,
};

export interface ExecutionContext {
  /** Where a read-only mode was set, absent on a read-write provider (spec E6). */
  readonly readOnly?: ReadOnlySource;
  readonly bounds: ExecutionBounds;
  /** The command's own signal, which index.ts builds from cancelQuery and the query timeout (spec 3.5, 5.5). */
  readonly signal: AbortSignal;
  /** "host:port" of the configured endpoint (plan C4's `endpoint`), for endpoint status and health. */
  readonly endpoint: string;
  /** The injected clock (spec 3.5): endpoint health's `took`, and the watch window's end. */
  readonly now: () => number;
  /** The injected timer: a --command-timeout's deadline and a watch's window; it answers the timer's cancel. */
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  readonly errors: EtcdErrorConnection;
  /** What the user may read, when spec 4.7's walks read the grants, for 5.6's PermissionDenied sentence. */
  readonly readable?: { readonly user: string; readonly ranges: string };
  /** Called once when a write request leaves the client, so cancelQuery answers false after it (spec 5.5). */
  readonly onWriteSent: () => void;
}

type GetSpec = Extract<TxnRequestSpec, { readonly kind: "get" }>;
type PutSpec = Extract<TxnRequestSpec, { readonly kind: "put" }>;
type DelSpec = Extract<TxnRequestSpec, { readonly kind: "del" }>;
type TxnCommand = Extract<EtcdCommand, { readonly kind: "txn" }>;
type WatchCommand = Extract<EtcdCommand, { readonly kind: "watch" }>;

/** etcd's default --max-txn-ops, the most Range ops one read-only Txn of E8's read carries (SRC `v3rpc/key.go` near 202-212). */
const MAX_TXN_OPS = 128;
/** A watch's window when no --command-timeout is given: etcdctl's default command timeout (spec 5.3). */
const DEFAULT_WATCH_WINDOW_MS = 5_000;
/** The key etcdctl's endpoint health reads (SRC `etcdctl/ctlv3/command/ep_command.go`, epHealthCommandFunc). */
const HEALTH_KEY = new TextEncoder().encode("health");
/** etcdctl's names for the alarm types, as endpoint health lists them; any other type is UNKNOWN there. */
const ALARM_NAMES: Readonly<Record<string, string>> = { nospace: "NOSPACE", corrupt: "CORRUPT" };
const COMPARE_RESULTS: Readonly<Record<TxnCompareOperator, EtcdCompareResult>> = {
  "=": "equal",
  "!=": "not-equal",
  "<": "less",
  ">": "greater",
};
/** Each command in etcdctl's words, "lease keep-alive" for lease-keep-alive-once, as errors.ts names it (spec 5.6). */
const COMMAND_WORDS: ReadonlyMap<string, string> = new Map(
  ETCD_COMMAND_TABLE.map((entry) => [entry.kind, entry.words.join(" ")]),
);

/** One command's run: the slice of the seam, the context, the options every call carries, and its error context. */
interface Run {
  readonly client: EtcdExecuteClient;
  readonly context: ExecutionContext;
  /** The caller's signal, shortened by a --command-timeout (spec 5.1.2). */
  readonly call: EtcdCallOptions;
  /** The command's error context (spec 5.6): its words, guard.ts's class, the range it names, the deadline it runs under. */
  readonly failure: EtcdErrorContext;
}

/** What E8's read found for one single-key write target, before any write (spec E8). */
interface StoredTarget {
  readonly key: EtcdBytes;
  /** The stored value; undefined for a key that does not exist; "unreadable" for a read etcd refused. */
  readonly stored: EtcdBytes | undefined | "unreadable";
  /** The key's mod_revision as read, "0" for a key that does not exist: the guarded Txn's compare. */
  readonly modRevision: EtcdInt64;
}

/**
 * write-policy.ts before any request, then one command within the bounds; every failure through
 * toProviderError but the sentences this module words (its docblock).
 */
export async function executeCommand(
  client: EtcdExecuteClient,
  parsed: ParsedCommand,
  context: ExecutionContext,
): Promise<CommandOutcome> {
  const { command } = parsed;
  const assessment = assessCommand(command);
  refuse(refuseBeforeSend(assessment, { readOnly: context.readOnly }));
  if (command.kind === "watch") {
    return { kind: "watch", outcome: await watch(client, command, parsed.commandTimeoutMs, context) };
  }
  const deadline = commandDeadline(context, parsed.commandTimeoutMs);
  const run: Run = {
    client,
    context,
    call: { signal: deadline.signal },
    failure: {
      command: COMMAND_WORDS.get(command.kind) as string,
      write: assessment.class === "write",
      range: rangeLabel(command),
      readable: context.readable,
      connection: { ...context.errors, timeoutMs: parsed.commandTimeoutMs ?? context.errors.timeoutMs },
    },
  };
  try {
    return await dispatch(run, command, assessment.singleKeyTargets);
  } finally {
    deadline.release();
  }
}

async function dispatch(
  run: Run,
  command: Exclude<EtcdCommand, WatchCommand>,
  targets: readonly EtcdBytes[],
): Promise<CommandOutcome> {
  const { client, call } = run;
  switch (command.kind) {
    case "get":
      return readGet(run, command);
    case "put":
      return guardedWrite(run, command);
    case "del":
      return isRanged(command) ? deleteRange(run, command) : guardedWrite(run, command);
    case "txn":
      return typedTxn(run, command, targets);
    case "lease-grant":
      return { kind: "lease-grant", response: await sendWrite(run, () => client.leaseGrant(command.ttlSeconds, call)) };
    case "lease-revoke":
      return revokeLease(run, command.leaseHex);
    case "lease-timetolive": {
      const id = leaseDecimal(command.leaseHex);
      const response = await send(run, () => client.leaseTimeToLive(id, command.keys, call));
      // A TTL of -1 is etcd's answer for a lease it does not hold: data, not an error (spec 5.6).
      if (response.ttl === "-1") throw leaseNotFoundError(command.leaseHex, run.failure.command);
      const [keys, held] = rowsHeld(run, response.keys);
      return { kind: "lease-timetolive", response: { ...response, keys }, keys: command.keys, ...held };
    }
    case "lease-list": {
      const [ids, held] = rowsHeld(run, (await send(run, () => client.leaseLeases(call))).ids);
      return { kind: "lease-list", ids, ...held };
    }
    case "lease-keep-alive-once": {
      const id = leaseDecimal(command.leaseHex);
      const response = await sendWrite(run, () => client.leaseKeepAliveOnce(id, call));
      // A TTL of 0 is etcd's answer for a lease it does not hold (spec 5.6).
      if (response.ttl === "0") throw leaseNotFoundError(command.leaseHex, run.failure.command);
      return { kind: "lease-keep-alive-once", response };
    }
    case "member-list": {
      // etcdctl's default is linearizable, and --consistency=s asks the member's own view (spec 5.1.3).
      const linearizable = command.consistency !== "s";
      return {
        kind: "member-list",
        members: (await send(run, () => client.memberList({ linearizable }, call))).members,
      };
    }
    case "endpoint-status":
      return {
        kind: "endpoint-status",
        endpoint: run.context.endpoint,
        status: await send(run, () => client.status(call)),
      };
    case "endpoint-health":
      return endpointHealth(run);
    case "alarm-list":
      return { kind: "alarm-list", alarms: await send(run, () => client.alarmList(call)) };
    case "auth-status":
      return { kind: "auth-status", status: await send(run, () => client.authStatus(call)) };
    case "user-list": {
      const [names, held] = rowsHeld(run, await send(run, () => client.userList(call)));
      return { kind: "user-list", names, ...held };
    }
    case "user-get":
      return userGet(run, command.name, command.detail);
    case "role-list": {
      const [names, held] = rowsHeld(run, await send(run, () => client.roleList(call)));
      return { kind: "role-list", names, ...held };
    }
    case "role-get": {
      const [permissions, held] = rowsHeld(run, await send(run, () => client.roleGet(command.name, call)));
      return { kind: "role-get", name: command.name, permissions, ...held };
    }
  }
}

/**
 * A list etcd answers whole, held to the rows a result holds (spec 5.4): its first `rowLimit` entries,
 * and, when etcd answered more, how many it answered, which results.ts names in its warning.
 */
function rowsHeld<T>(run: Run, entries: readonly T[]): readonly [readonly T[], { readonly answered?: number }] {
  const { rowLimit } = run.context.bounds;
  return entries.length > rowLimit ? [entries.slice(0, rowLimit), { answered: entries.length }] : [entries, {}];
}

/** A decision of write-policy.ts, raised before the request it refuses; its sentence quotes no value (spec E6, E8). */
function refuse(refusal: PolicyRefusal | undefined): void {
  if (refusal !== undefined) throw new QueryError(refusal.message, PROVIDER);
}

/**
 * The signal every call of a command carries: the caller's, and for a --command-timeout a deadline
 * the injected clock sets as well, whose reason is a TimeoutError, so errors.ts reads its abort as a
 * deadline and never as a cancel (spec 5.1.2, 5.6).
 */
function commandDeadline(
  context: ExecutionContext,
  timeoutMs: number | undefined,
): { readonly signal: AbortSignal; readonly release: () => void } {
  if (timeoutMs === undefined) return { signal: context.signal, release: () => undefined };
  const deadline = new AbortController();
  const release = context.setTimer(timeoutMs, () =>
    deadline.abort(new DOMException("--command-timeout reached", "TimeoutError")),
  );
  return { signal: AbortSignal.any([context.signal, deadline.signal]), release };
}

/** The key or range a command names, as errors.ts's sentences write it (spec 5.6). */
function rangeLabel(command: Exclude<EtcdCommand, WatchCommand>): string | undefined {
  switch (command.kind) {
    case "get":
    case "del":
      return describeRange(commandRange(command));
    case "put":
      return describeRange({ key: command.key });
    default:
      return undefined;
  }
}

/** One call of the command, its failure mapped by errors.ts in the context given, the command's own by default. */
async function send<T>(run: Run, call: () => Promise<T>, failure: EtcdErrorContext = run.failure): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toProviderError(error, failure);
  }
}

/**
 * Sends the command's write. A command whose signal has already stopped it sends nothing, and is
 * refused as the read it then is, since no write left the client; otherwise onWriteSent runs first,
 * so cancelQuery answers false from here on (spec 5.5).
 */
async function sendWrite<T>(run: Run, call: () => Promise<T>): Promise<T> {
  const { signal } = run.call;
  if (signal.aborted) throw toProviderError(toEtcdError(signal.reason, signal), { ...run.failure, write: false });
  run.context.onWriteSent();
  return send(run, call);
}

/** The error context of a request read before the command's write: a read, so its failure says nothing was written. */
function readBefore(run: Run): EtcdErrorContext {
  return { ...run.failure, command: `read before the ${run.failure.command}`, write: false };
}

const isRanged = (spec: GetSpec | DelSpec): boolean => spec.rangeEnd !== undefined || spec.prefix || spec.fromKey;
const isPermissionDenied = (error: unknown): boolean =>
  error instanceof EtcdError && error.category === "permission-denied";
const isUnreadable = (target: StoredTarget): boolean => target.stored === "unreadable";
const rangeOp = (key: EtcdBytes): EtcdRequestOp => ({ op: "range", request: { key, limit: 1 } });

/** The answer at `index` of a Txn, which must be of the op its request put there; anything else is raised. */
function answerAt<K extends EtcdResponseOp["op"]>(
  response: EtcdTxnResponse,
  index: number,
  op: K,
): Extract<EtcdResponseOp, { readonly op: K }> {
  const answer = response.responses[index];
  if (answer?.op !== op) {
    throw new EtcdError("unknown", `etcd's txn answer holds no ${op} response at position ${index + 1}`);
  }
  return answer as Extract<EtcdResponseOp, { readonly op: K }>;
}

/** A lease id from the hexadecimal the parser writes to the decimal the seam carries (spec 4.1). */
function leaseDecimal(hex: string): EtcdInt64 {
  const decimal = fromHexId(hex);
  if (decimal === undefined) {
    throw new QueryError("The lease id is not hexadecimal: write it as lease list prints it.", PROVIDER);
  }
  return decimal;
}

function rangeRequest(
  spec: GetSpec,
  range: EtcdByteRange,
  limit: number,
  revision: EtcdInt64 | undefined,
): EtcdRangeRequest {
  return {
    ...range,
    limit,
    ...(revision === undefined ? {} : { revision }),
    keysOnly: spec.keysOnly,
    countOnly: spec.countOnly,
    serializable: spec.consistency === "s",
  };
}

function putRequest(spec: PutSpec): EtcdPutRequest {
  return {
    key: spec.key,
    value: spec.value,
    ...(spec.lease === undefined ? {} : { lease: leaseDecimal(spec.lease) }),
    prevKv: spec.prevKv,
    ignoreValue: spec.ignoreValue,
    ignoreLease: spec.ignoreLease,
  };
}

function deleteRequest(spec: DelSpec): EtcdDeleteRangeRequest {
  return { ...commandRange(spec), prevKv: spec.prevKv };
}

/** A txn request, or a guarded write's own op, as etcd receives it (spec 5.1.4, E14). */
function requestOp(spec: TxnRequestSpec, bounds: ExecutionBounds): EtcdRequestOp {
  switch (spec.kind) {
    case "get": {
      // A ranged get inside a txn is bounded in the request, at its --limit or P, because etcd
      // builds a txn's whole answer at once and it cannot be paged; a count carries limit 1, since
      // etcd counts the whole range whatever the limit (spec 5.1.4, E14).
      const limit = spec.countOnly ? 1 : (spec.limit ?? (isRanged(spec) ? bounds.firstPageSize : 1));
      return { op: "range", request: rangeRequest(spec, commandRange(spec), limit, spec.revision) };
    }
    case "put":
      return { op: "put", request: putRequest(spec) };
    case "del":
      return { op: "delete", request: deleteRequest(spec) };
  }
}

/** A compare as etcd receives it: a lease operand from its hexadecimal id to decimal, the rest as parsed (spec 5.1.4). */
function compareOf(spec: TxnCompareSpec): EtcdCompare {
  const operand = spec.target === "lease" ? leaseDecimal(spec.operand) : spec.operand;
  return { key: spec.key, target: spec.target, result: COMPARE_RESULTS[spec.operator], operand };
}

function txnRequest(command: TxnCommand, bounds: ExecutionBounds): EtcdTxnRequest {
  return {
    compare: command.compares.map(compareOf),
    success: command.success.map((spec) => requestOp(spec, bounds)),
    failure: command.failure.map((spec) => requestOp(spec, bounds)),
  };
}

function storedOf(key: EtcdBytes, response: EtcdRangeResponse): StoredTarget {
  const kv = response.kvs[0];
  return kv === undefined
    ? { key, stored: undefined, modRevision: "0" }
    : { key, stored: kv.value, modRevision: kv.modRevision };
}

/**
 * The stored values of E8's single-key write targets, read before any write (spec E8): one Range
 * for one target, else read-only Txns of at most 128 Range ops each, one after another. A key etcd
 * will not show is "unreadable", and nothing after it is read, because write-policy.ts then
 * refuses the command whatever the other targets hold.
 */
async function readTargets(run: Run, keys: readonly EtcdBytes[]): Promise<StoredTarget[]> {
  if (keys.length === 1) return [await readTarget(run, keys[0])];
  const read: StoredTarget[] = [];
  for (let start = 0; start < keys.length && !read.some(isUnreadable); start += MAX_TXN_OPS) {
    // oxlint-disable-next-line no-await-in-loop -- one read-only Txn at a time, and none after a refused key.
    read.push(...(await readBatch(run, keys.slice(start, start + MAX_TXN_OPS))));
  }
  return read;
}

async function readTarget(run: Run, key: EtcdBytes): Promise<StoredTarget> {
  try {
    return storedOf(key, await run.client.range({ key, limit: 1 }, run.call));
  } catch (error) {
    if (isPermissionDenied(error)) return { key, stored: "unreadable", modRevision: "0" };
    throw toProviderError(error, readBefore(run));
  }
}

async function readBatch(run: Run, keys: readonly EtcdBytes[]): Promise<StoredTarget[]> {
  const request: EtcdTxnRequest = { compare: [], success: keys.map(rangeOp), failure: [] };
  try {
    const response = await run.client.txn(request, run.call);
    return keys.map((key, index) => storedOf(key, answerAt(response, index, "range").response));
  } catch (error) {
    if (!isPermissionDenied(error)) throw toProviderError(error, readBefore(run));
  }
  // etcd refuses a whole Txn when one of its Ranges is not granted, so each key is read alone, up
  // to the first one etcd refuses, and the refusal names the key this connection may not read.
  const read: StoredTarget[] = [];
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- one key at a time, stopping at the first etcd refuses.
    const target = await readTarget(run, key);
    read.push(target);
    if (isUnreadable(target)) break;
  }
  return read;
}

/** A guarded Txn whose compare failed: nothing was written, and the sentence names what its failure branch read, never the value. */
function notApplied(command: string, key: string, current: EtcdRangeResponse): QueryError {
  const now = current.kvs[0];
  const changed =
    now === undefined
      ? `${key} was deleted after Studio read it`
      : `${key} changed after Studio read it, and etcd now holds it at mod_revision ${now.modRevision}`;
  return new QueryError(
    `etcd did not apply the ${command}, because ${changed}. Nothing was written: read the key again, then run the ${command} again.`,
    PROVIDER,
  );
}

/**
 * E8's guarded write of one key (spec E8): the key read first and its stored value handed to
 * write-policy.ts, then one Txn whose compare holds the mod_revision the read found ("0" for a
 * key that did not exist), whose success branch is the command's own op with its flags, and whose
 * failure branch reads the key. A Txn that does not succeed is refused, and nothing is retried.
 */
async function guardedWrite(run: Run, spec: PutSpec | DelSpec): Promise<CommandOutcome> {
  const op = requestOp(spec, run.context.bounds);
  const [target] = await readTargets(run, [spec.key]);
  refuse(refuseStoredValues([target]));
  const request: EtcdTxnRequest = {
    compare: [{ key: spec.key, target: "mod", result: "equal", operand: target.modRevision }],
    success: [op],
    failure: [rangeOp(spec.key)],
  };
  return sendWrite(run, async () => {
    const response = await run.client.txn(request, run.call);
    if (!response.succeeded) {
      throw notApplied(run.failure.command, describeRange({ key: spec.key }), answerAt(response, 0, "range").response);
    }
    if (spec.kind === "put") {
      const { prevKv } = answerAt(response, 0, "put").response;
      return {
        kind: "put",
        key: spec.key,
        response: { header: response.header, ...(prevKv === undefined ? {} : { prevKv }) },
      };
    }
    const { deleted, prevKvs } = answerAt(response, 0, "delete").response;
    return { kind: "del", response: { header: response.header, deleted, prevKvs } };
  });
}

/** A del with a range end, --prefix or --from-key: one DeleteRange, not read first, the documented limit of E8's content rule. */
async function deleteRange(run: Run, spec: DelSpec): Promise<CommandOutcome> {
  const request = deleteRequest(spec);
  return { kind: "del", response: await sendWrite(run, () => run.client.deleteRange(request, run.call)) };
}

/**
 * A typed txn, sent as written (spec 5.1.4). One holding a write reads its single-key write
 * targets first, for E8's content rule, in a request that is not atomic with the txn (spec E8).
 */
async function typedTxn(run: Run, command: TxnCommand, targets: readonly EtcdBytes[]): Promise<CommandOutcome> {
  const request = txnRequest(command, run.context.bounds);
  if (!run.failure.write) {
    return { kind: "txn", request, response: await send(run, () => run.client.txn(request, run.call)) };
  }
  refuse(refuseStoredValues(await readTargets(run, targets)));
  return { kind: "txn", request, response: await sendWrite(run, () => run.client.txn(request, run.call)) };
}

/**
 * lease revoke (spec E8): revoking a lease deletes every key it holds, so its keys are read first,
 * with LeaseTimeToLive keys: true, for write-policy.ts, and a lease whose keys etcd will not show
 * is refused too. A lease etcd does not hold answers a TTL of -1, and nothing is revoked.
 */
async function revokeLease(run: Run, leaseHex: string): Promise<CommandOutcome> {
  const id = leaseDecimal(leaseHex);
  const lease = await readLeaseKeys(run, id);
  if (lease !== "unreadable" && lease.ttl === "-1") throw leaseNotFoundError(leaseHex, run.failure.command);
  refuse(refuseLeaseRevoke(lease === "unreadable" ? lease : lease.keys));
  await sendWrite(run, () => run.client.leaseRevoke(id, run.call));
  return { kind: "lease-revoke", id };
}

async function readLeaseKeys(run: Run, id: EtcdInt64): Promise<EtcdLeaseTimeToLiveResponse | "unreadable"> {
  try {
    return await run.client.leaseTimeToLive(id, true, run.call);
  } catch (error) {
    if (isPermissionDenied(error)) return "unreadable";
    throw toProviderError(error, readBefore(run));
  }
}

/** The smallest key after `key`, where the next page starts: `key` followed by one 0x00 byte. */
function after(key: EtcdBytes): EtcdBytes {
  const next = new Uint8Array(key.byteLength + 1);
  next.set(key);
  return next;
}

/**
 * A compaction that reached the revision a read pins its pages to, after its first page (plan
 * Review Focus 2): the rows read are not the whole answer, so none is shown, and the sentence says
 * what happened, never spec 5.6's, which answers a revision the user typed and etcd had compacted.
 */
function overtaken(command: string, revision: EtcdInt64, typed: boolean): QueryError {
  const pinned = typed ? "the --rev it reads at" : "the revision its pages are pinned to";
  const again = typed ? `Run the ${command} again with a later --rev.` : `Run the ${command} again.`;
  return new QueryError(
    `A compaction overtook the ${command}: etcd compacted revision ${revision}, ${pinned}, after the first page was read, so the rows read are not the whole answer and none is shown. ${again} (etcd: mvcc: required revision has been compacted)`,
    PROVIDER,
  );
}

/**
 * One page of a get, and the limit it was read with. etcd's Range limits a page by its count of keys
 * alone, so a page whose answer the receive cap refused (KE4, measured: twenty values of 1 MiB answered
 * 20,972,150 bytes past the 16 MiB cap) is asked again from the same key, at the same revision, with
 * half its limit; a page of one key the cap refuses raises the cap's sentence.
 */
async function readPage(
  run: Run,
  spec: GetSpec,
  range: EtcdByteRange,
  limit: number,
  revision: EtcdInt64 | undefined,
  later: boolean,
): Promise<{ readonly answer: EtcdRangeResponse; readonly limit: number }> {
  try {
    return { answer: await run.client.range(rangeRequest(spec, range, limit, revision), run.call), limit };
  } catch (error) {
    if (limit > 1 && error instanceof EtcdError && error.category === "resource-exhausted") {
      return readPage(run, spec, range, Math.floor(limit / 2), revision, later);
    }
    if (later && error instanceof EtcdError && error.category === "compacted") {
      throw overtaken(run.failure.command, revision as EtcdInt64, spec.revision !== undefined);
    }
    throw toProviderError(error, run.failure);
  }
}

/**
 * A get (spec 5.4, E14). A count is one count_only Range. Rows are read in pages from the start of
 * the range, each page after the first pinned to the revision the first answered at, or to the
 * typed --rev, so the rows are one view of the key space. The read stops at the end of the range,
 * at the rows the result may hold, or before the row that would take the rows' keys and values
 * past the byte budget, the first row held however large, so an oversized value still answers one
 * row, cut at the cell bound. Without a typed --limit a page asks for one key past the row limit,
 * so a read the limit cuts names the key it stopped before; a typed --limit narrows the read, and
 * the last answer's `more` says whether it cut it.
 */
async function readGet(run: Run, spec: GetSpec): Promise<CommandOutcome> {
  const { bounds } = run.context;
  const range = commandRange(spec);
  if (spec.countOnly) {
    const counted = await send(run, () => run.client.range(rangeRequest(spec, range, 1, spec.revision), run.call));
    return {
      kind: "get",
      kvs: [],
      count: counted.count,
      keysOnly: false,
      countOnly: true,
      more: false,
      header: counted.header,
    };
  }
  const rowCap = Math.min(spec.limit ?? bounds.rowLimit, bounds.rowLimit);
  const asked = spec.limit === undefined ? rowCap + 1 : rowCap;
  const kvs: EtcdKeyValue[] = [];
  let bytes = 0;
  let size = bounds.firstPageSize;
  /** Holds a page's rows up to the first the bounds stop before, and answers that stop and the bytes held. */
  const take = (answer: EtcdRangeResponse): { readonly stopped?: ReadStop; readonly pageBytes: number } => {
    let pageBytes = 0;
    for (const kv of answer.kvs) {
      if (kvs.length === rowCap) return { stopped: { by: "rows", beforeKey: kv.key }, pageBytes };
      const rowBytes = kv.key.byteLength + kv.value.byteLength;
      if (kvs.length > 0 && bytes + rowBytes > bounds.byteBudget) {
        return { stopped: { by: "bytes", beforeKey: kv.key }, pageBytes };
      }
      kvs.push(kv);
      bytes += rowBytes;
      pageBytes += rowBytes;
    }
    return { pageBytes };
  };
  const first = Math.min(size, asked);
  let read = await readPage(run, spec, range, first, spec.revision, false);
  // A page the receive cap made smaller is the size the read goes on from (KE4).
  if (read.limit < first) size = read.limit;
  let page = read.answer;
  const { header } = page;
  const revision = spec.revision ?? header.revision;
  let taken = take(page);
  while (taken.stopped === undefined && page.more && kvs.length < asked) {
    // A page that holds no key cannot move the read on, so it ends the read rather than ask again.
    if (page.kvs.length === 0) {
      throw new QueryError(
        `etcd answered a page of the ${run.failure.command} with no keys and more to follow, so Studio stopped the read: run it again.`,
        PROVIDER,
      );
    }
    if (taken.pageBytes * 2 <= bounds.byteBudget - bytes) size = Math.min(size * 2, bounds.maxPageSize);
    const from = after(kvs[kvs.length - 1].key);
    const wanted = Math.min(size, asked - kvs.length);
    // oxlint-disable-next-line no-await-in-loop -- each page starts past the last key of the page before it.
    read = await readPage(run, spec, { ...range, key: from }, wanted, revision, true);
    if (read.limit < wanted) size = read.limit;
    page = read.answer;
    taken = take(page);
  }
  return {
    kind: "get",
    kvs,
    keysOnly: spec.keysOnly,
    countOnly: false,
    more: taken.stopped !== undefined || page.more,
    ...(taken.stopped === undefined ? {} : { stopped: taken.stopped }),
    header,
  };
}

/**
 * A probe failure that endpoint health reports in its row; the caller's own cancel (spec 5.5) and
 * a failure that is not etcd's (a defect) are raised instead.
 */
function reportedFailure(run: Run, failure: unknown): EtcdError {
  if (failure instanceof EtcdError && failure.category !== "cancelled") return failure;
  throw toProviderError(failure, run.failure);
}

/**
 * endpoint health, as etcdctl probes it (spec 5.1.3): one linearizable Range of the key `health`,
 * keys only and with limit 1, whose answer is never shown, then the whole cluster's alarms. It
 * answers its one row rather than raising what it measures: PermissionDenied counts as healthy,
 * since etcd checks it after the read's quorum round, and any other failure is the row's error.
 * `took` is the read's duration alone, and Status is never read.
 */
async function endpointHealth(run: Run): Promise<CommandOutcome> {
  const { endpoint, now } = run.context;
  const started = now();
  let error: string | undefined;
  try {
    await run.client.range({ key: HEALTH_KEY, limit: 1, keysOnly: true }, run.call);
  } catch (failure) {
    const reported = reportedFailure(run, failure);
    if (reported.category !== "permission-denied") error = toProviderError(reported, run.failure).message;
  }
  const tookMs = now() - started;
  if (error !== undefined) return { kind: "endpoint-health", endpoint, healthy: false, tookMs, error };
  let alarms: readonly EtcdAlarm[];
  try {
    alarms = await run.client.alarmList(run.call);
  } catch (failure) {
    reportedFailure(run, failure);
    return { kind: "endpoint-health", endpoint, healthy: false, tookMs, error: "Unable to fetch the alarm list" };
  }
  if (alarms.length === 0) return { kind: "endpoint-health", endpoint, healthy: true, tookMs };
  const names = alarms.map((alarm) => ALARM_NAMES[alarm.alarm] ?? "UNKNOWN");
  return { kind: "endpoint-health", endpoint, healthy: false, tookMs, error: `Active Alarm(s): ${names.join(" ")}` };
}

/** user get, and with --detail each of the user's roles read as well, in the order the user holds them (spec 5.1.3). */
async function userGet(run: Run, name: string, detail: boolean): Promise<CommandOutcome> {
  const { client, call } = run;
  const roles = await send(run, () => client.userGet(name, call));
  if (!detail) return { kind: "user-get", name, roles };
  const granted = await send(run, () => Promise.all(roles.map((role) => client.roleGet(role, call))));
  const [permissions, held] = rowsHeld(
    run,
    roles.flatMap((role, index) => granted[index].map((permission) => ({ role, permission }))),
  );
  return { kind: "user-get", name, roles, permissions, ...held };
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${(ms / 1000).toLocaleString("en-US")} s` : `${ms.toLocaleString("en-US")} ms`;
}

/**
 * A watch (spec 5.3): its window is the typed --command-timeout, else etcdctl's 5 seconds, and at
 * most the query timeout less the watch margin, while the call's own deadline stays the query
 * timeout. A default window the cap shortened says so in its warning. A query timeout at or below
 * the margin leaves no window, and a typed window above the cap is refused as the parser refuses
 * it, each naming both, with no request (KE5).
 */
async function watch(
  client: EtcdExecuteClient,
  command: WatchCommand,
  typedWindowMs: number | undefined,
  context: ExecutionContext,
): Promise<WatchOutcome> {
  const { queryTimeoutMs, watchMarginMs, rowLimit, byteBudget } = context.bounds;
  const cap = queryTimeoutMs - watchMarginMs;
  if (cap <= 0) {
    throw new QueryError(
      `This connection's query timeout of ${formatMs(queryTimeoutMs)} leaves a watch no window, because a watch keeps its last ${formatMs(watchMarginMs)} to return its events: raise Query Timeout in the connection's settings to watch.`,
      PROVIDER,
    );
  }
  if (typedWindowMs !== undefined && typedWindowMs > cap) {
    throw new QueryError(
      `The watch window of ${formatMs(typedWindowMs)} that --command-timeout sets is above ${formatMs(cap)}, this connection's query timeout less the ${formatMs(watchMarginMs)} a watch keeps to return its events: lower it, or raise Query Timeout in the connection's settings.`,
      PROVIDER,
    );
  }
  const range = commandRange({ key: command.key, rangeEnd: command.rangeEnd, prefix: command.prefix, fromKey: false });
  const request: EtcdWatchRequest = {
    ...range,
    ...(command.revision === undefined ? {} : { startRevision: command.revision }),
    prevKv: command.prevKv,
  };
  const capped = typedWindowMs === undefined && cap < DEFAULT_WATCH_WINDOW_MS;
  return runBoundedWatch(
    client,
    request,
    {
      windowMs: typedWindowMs ?? Math.min(DEFAULT_WATCH_WINDOW_MS, cap),
      ...(capped ? { capped: { queryTimeoutMs } } : {}),
      rowLimit,
      byteBudget,
      rangeLabel: describeRange(range),
    },
    {
      signal: context.signal,
      now: context.now,
      setTimer: context.setTimer,
      errors: context.errors,
      readable: context.readable,
    },
  );
}
