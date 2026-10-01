/**
 * The one reader of the etcd fixtures, and the recorded transport the provider's tests run the real adapter over
 * (spec 10, gate 4; plan Contract C11).
 *
 * `tests/fixtures/etcd/<service>/` holds what etcd v3.7.2 answered @grpc/grpc-js before any provider code was
 * written, one surface per file, captured by `tests/live/etcd-evidence.ts` as the README beside them says. Each
 * file is `{ "$captured": {...}, "outcome": "pass" | "fail", "payload": ... }`, with bytes written as
 * `{ "$bytes": "<base64>" }`, or as `{ "$filled": { "byte", "length" } }` for a long run of one byte, and a 64-bit
 * integer as `{ "$int64": "<digits>" }`. `reviveEtcdFixture` turns them back into what grpc-js hands over with the
 * adapter's loader options: a `Buffer`, and the decimal string of `longs: String`. A failure's payload becomes an `Error` with the gRPC status's `code` and `details`, or a
 * runtime error's string `code`, as its own properties, so the adapter's `toEtcdError` classifies it as it
 * classifies the live one.
 *
 * `recordedEtcdWire` is a recorded transport: it has the shape of the adapter's `EtcdWireTransport` (C5), logs
 * every channel, call, write, cancel and close, and answers each call from these captures unless a test's
 * `answers` names it first. It imports nothing from @grpc/grpc-js or the descriptor, so the seam guard's list of
 * importers stays the adapter's own (spec E11).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "fixtures", "etcd");

export type EtcdFixtureService = "etcd" | "etcd-cluster" | "etcd-auth" | "etcd-auth-password" | "transport";

export interface EtcdCaptureProvenance {
  readonly service: EtcdFixtureService;
  readonly image: string;
  readonly digest: string;
  readonly clusterId: string;
  readonly memberId: string;
  readonly date: string;
  readonly runtime: string;
  /** "<service>/<method>" (C5's EtcdWireRpc), or "none" for a transport failure before any call. */
  readonly rpc: string;
  readonly surface: string;
  readonly request: unknown;
  readonly match: Readonly<Record<string, unknown>>;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface EtcdCapture {
  readonly $captured: EtcdCaptureProvenance;
  readonly outcome: "pass" | "fail";
  /** Revived: a unary answer, `{ messages, end }` for a stream, or the Error of a failure. */
  readonly payload: unknown;
}

/** Every capture as "<directory>/<file stem>", sorted; a test holds it equal to the `.json` files of the five directories. */
export const ETCD_FIXTURE_NAMES: readonly string[] = [
  "etcd-auth-password/authenticate",
  "etcd-auth-password/error-auth-revision-old",
  "etcd-auth-password/error-authenticate-no-password-user",
  "etcd-auth-password/error-authenticate-wrong-password",
  "etcd-auth-password/error-invalid-auth-token",
  "etcd-auth-password/error-range-no-token",
  "etcd-auth-password/error-user-name-empty-certificate",
  "etcd-auth-password/range-token-before-auth-change",
  "etcd-auth-password/status",
  "etcd-auth-password/watch-invalid-auth-token",
  "etcd-auth/alarm-disarm-root",
  "etcd-auth/auth-status-on",
  "etcd-auth/compact-root",
  "etcd-auth/defragment-root",
  "etcd-auth/error-permission-denied",
  "etcd-auth/error-permission-denied-alarm-disarm",
  "etcd-auth/error-permission-denied-compact",
  "etcd-auth/error-permission-denied-defragment",
  "etcd-auth/error-permission-denied-lease-leases",
  "etcd-auth/error-permission-denied-no-common-name",
  "etcd-auth/error-permission-denied-role-list",
  "etcd-auth/error-permission-denied-user-list",
  "etcd-auth/error-plaintext-to-tls.bun",
  "etcd-auth/error-plaintext-to-tls.node",
  "etcd-auth/error-tls-chain.bun",
  "etcd-auth/error-tls-chain.node",
  "etcd-auth/error-tls-client-certificate-refused.bun",
  "etcd-auth/error-tls-client-certificate-refused.node",
  "etcd-auth/error-tls-client-certificate-required.bun",
  "etcd-auth/error-tls-client-certificate-required.node",
  "etcd-auth/error-tls-name.bun",
  "etcd-auth/error-tls-name.node",
  "etcd-auth/error-user-name-empty",
  "etcd-auth/error-user-name-not-found",
  "etcd-auth/range-health-permission-denied",
  "etcd-auth/range-reader-app",
  "etcd-auth/range-reader-config-a",
  "etcd-auth/role-get-reader",
  "etcd-auth/role-list",
  "etcd-auth/status",
  "etcd-auth/user-get-cert-only",
  "etcd-auth/user-get-reader",
  "etcd-auth/user-list",
  "etcd-auth/watch-permission-denied",
  "etcd-cluster/alarm-disarm",
  "etcd-cluster/alarm-disarm-member-zero",
  "etcd-cluster/alarm-list-nospace",
  "etcd-cluster/defragment",
  "etcd-cluster/defragment-no-leader-hasleader",
  "etcd-cluster/error-connection-dropped",
  "etcd-cluster/error-deadline-before-pick.bun",
  "etcd-cluster/error-deadline-before-pick.node",
  "etcd-cluster/error-no-leader",
  "etcd-cluster/error-no-leader-txn-put",
  "etcd-cluster/error-no-space",
  "etcd-cluster/lease-leases-no-leader-hasleader",
  "etcd-cluster/member-list",
  "etcd-cluster/member-list-serializable-no-leader",
  "etcd-cluster/member-list-serializable-no-leader-hasleader",
  "etcd-cluster/range-serializable-no-leader",
  "etcd-cluster/range-serializable-no-leader-hasleader",
  "etcd-cluster/status-after-defragment",
  "etcd-cluster/status-before-defragment",
  "etcd-cluster/status-follower",
  "etcd-cluster/status-leader",
  "etcd-cluster/status-no-leader",
  "etcd-cluster/status-no-leader-hasleader",
  "etcd-cluster/txn-serializable-gets-no-leader-hasleader",
  "etcd/alarm-list-none",
  "etcd/auth-status-off",
  "etcd/compact",
  "etcd/defragment",
  "etcd/delete-range-prefix",
  "etcd/error-authenticate-not-enabled",
  "etcd/error-cancelled-on-client",
  "etcd/error-client-receive-cap",
  "etcd/error-deadline-after-send.bun",
  "etcd/error-deadline-after-send.node",
  "etcd/error-lease-revoke-not-found",
  "etcd/error-range-compacted",
  "etcd/error-range-future-revision",
  "etcd/error-server-receive-cap",
  "etcd/error-tls-to-plaintext.bun",
  "etcd/error-tls-to-plaintext.node",
  "etcd/error-txn-duplicate-key",
  "etcd/error-txn-request-too-large",
  "etcd/error-txn-too-many-ops",
  "etcd/lease-grant",
  "etcd/lease-keep-alive",
  "etcd/lease-keep-alive-expired",
  "etcd/lease-leases",
  "etcd/lease-revoke",
  "etcd/lease-time-to-live-keys",
  "etcd/lease-time-to-live-unknown",
  "etcd/member-list",
  "etcd/member-list-serializable",
  "etcd/range-compact-rev-key",
  "etcd/range-count-only-all",
  "etcd/range-count-only-prefix",
  "etcd/range-health",
  "etcd/range-history-rev",
  "etcd/range-key",
  "etcd/range-keys-only-all",
  "etcd/range-keys-only-from",
  "etcd/range-missing",
  "etcd/range-prefix-app",
  "etcd/range-prefix-app-limit-2",
  "etcd/range-prefix-registry",
  "etcd/range-prefix-registry-slashless",
  "etcd/range-prefix-tenant-a",
  "etcd/range-prefix-values",
  "etcd/range-serializable",
  "etcd/status",
  "etcd/txn-guarded-create",
  "etcd/txn-guarded-delete",
  "etcd/txn-guarded-put",
  "etcd/txn-guarded-put-conflict",
  "etcd/txn-read-targets",
  "etcd/txn-typed",
  "etcd/watch-compacted",
  "etcd/watch-history",
  "etcd/watch-prefix",
  "etcd/watch-quiet",
  "transport/error-deadline-name-resolution.bun",
  "transport/error-deadline-name-resolution.node",
  "transport/error-refused.bun",
  "transport/error-refused.node",
];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DIGITS = /^-?\d+$/;

/** `{ byte, length }` and nothing else: a byte value, and a length a Buffer can have. */
function isFilled(value: unknown): value is { byte: number; length: number } {
  if (value === null || typeof value !== "object" || Object.keys(value).sort().join() !== "byte,length") return false;
  const { byte, length } = value as { byte: unknown; length: unknown };
  return (
    Number.isInteger(byte) &&
    (byte as number) >= 0 &&
    (byte as number) <= 255 &&
    Number.isSafeInteger(length) &&
    (length as number) >= 0
  );
}

/** $bytes and $filled to a Buffer, $int64 to its digit string; throws on any other "$" key. */
export function reviveEtcdFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveEtcdFixture);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const marked = keys.filter((key) => key.startsWith("$"));
  if (marked.length === 0) return Object.fromEntries(keys.map((key) => [key, reviveEtcdFixture(record[key])]));
  if (keys.length === 1 && typeof record.$bytes === "string" && BASE64.test(record.$bytes)) {
    return Buffer.from(record.$bytes, "base64");
  }
  if (keys.length === 1 && isFilled(record.$filled)) return Buffer.alloc(record.$filled.length, record.$filled.byte);
  if (keys.length === 1 && typeof record.$int64 === "string" && DIGITS.test(record.$int64)) return record.$int64;
  throw new Error(
    `An etcd fixture holds ${JSON.stringify(record)}: only { "$bytes": <base64> }, { "$filled": { "byte", "length" } } and { "$int64": <digits> } are encodings`,
  );
}

/** A failure payload, `{ class, message, code, details? }`, as the Error grpc-js raised or the runtime threw. */
function failure(payload: unknown, name: string): Error {
  const fields = payload as { class?: unknown; message?: unknown; code?: unknown; details?: unknown };
  if (typeof fields?.message !== "string" || typeof fields.class !== "string") {
    throw new Error(`${name} is a failure whose payload has no class and message`);
  }
  const error = new Error(fields.message);
  error.name = fields.class;
  if (fields.code !== undefined) Object.assign(error, { code: fields.code });
  if (fields.details !== undefined) Object.assign(error, { details: fields.details });
  return error;
}

function isStream(payload: unknown): payload is { messages: unknown[]; end: unknown } {
  return typeof payload === "object" && payload !== null && Array.isArray((payload as { messages?: unknown }).messages);
}

function revivePayload(outcome: "pass" | "fail", payload: unknown, name: string): unknown {
  if (isStream(payload)) {
    const end = payload.end;
    const revivedEnd =
      end === "open" || end === "server-end"
        ? end
        : typeof end === "object" && end !== null && "error" in end
          ? { error: failure(reviveEtcdFixture((end as { error: unknown }).error), name) }
          : undefined;
    if (revivedEnd === undefined)
      throw new Error(`${name} is a stream whose end is not "open", "server-end" or { error }`);
    return { messages: payload.messages.map(reviveEtcdFixture), end: revivedEnd };
  }
  return outcome === "fail" ? failure(reviveEtcdFixture(payload), name) : reviveEtcdFixture(payload);
}

/** One parsed capture file, checked and revived; `name` is its "<directory>/<file stem>". */
export function reviveEtcdCapture(name: string, parsed: unknown): EtcdCapture {
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["$captured", "outcome", "payload"])) {
    throw new Error(`${name}.json holds ${keys.join(", ")}; every capture is { $captured, outcome, payload }`);
  }
  const outcome = record.outcome;
  if (outcome !== "pass" && outcome !== "fail") throw new Error(`${name}.json has the outcome ${String(outcome)}`);
  const captured = record.$captured as Record<string, unknown>;
  const service = name.split("/")[0];
  if (captured.service !== service) throw new Error(`${name}.json says it was captured on ${String(captured.service)}`);
  return {
    $captured: {
      ...(captured as unknown as EtcdCaptureProvenance),
      request: reviveEtcdFixture(captured.request),
      match: reviveEtcdFixture(captured.match) as Record<string, unknown>,
    },
    outcome,
    payload: revivePayload(outcome, record.payload, name),
  };
}

export function etcdCapture(name: string): EtcdCapture {
  return reviveEtcdCapture(name, JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")));
}

export function etcdFixture<T = unknown>(name: string): T {
  return etcdCapture(name).payload as T;
}

// -- the recorded transport -------------------------------------------------------------------------------------

/** A recorded answer: a capture by name, or a function of the request that returns an answer or throws to reject. */
export type RecordedEtcdAnswer = { readonly fixture: string } | ((request: unknown, call: RecordedEtcdCall) => unknown);

export interface RecordedEtcdCall {
  readonly rpc: string;
  /** For a stream, its first written message. */
  readonly request: unknown;
  readonly metadata: Readonly<Record<string, string>>;
  readonly deadline: Date;
}

export interface RecordedEtcdWireOptions {
  /** Whose captures answer a call that no `answers` entry takes; "etcd" when absent. */
  readonly service?: EtcdFixtureService;
  /** Per rpc, answers used in order before the captures are searched. */
  readonly answers?: Readonly<Record<string, readonly RecordedEtcdAnswer[]>>;
}

interface WireCall {
  readonly metadata: Readonly<Record<string, string>>;
  readonly deadline: Date;
  readonly signal: AbortSignal;
}

interface WireStream {
  write(message: object): void;
  read(): Promise<object | undefined>;
  cancel(): void;
}

export interface RecordedEtcdWire {
  /** createGrpcEtcdClient's third argument: structurally C5's EtcdWireTransport. */
  readonly transport: (options: unknown) => {
    unary(rpc: string, request: object, call: WireCall): Promise<object>;
    stream(rpc: string, call: WireCall): WireStream;
    close(): void;
  };
  /** The options each channel was opened with, in order. */
  readonly opened: readonly unknown[];
  /** Every unary call and every stream, in order, recorded before it is answered. */
  readonly calls: readonly RecordedEtcdCall[];
  /** Every message written on a stream after its first, in order. */
  readonly writes: ReadonlyArray<{ readonly rpc: string; readonly message: unknown }>;
  /** The rpc of each stream the adapter cancelled. */
  readonly cancels: readonly string[];
  readonly closes: number;
}

/** What grpc-js raises for a call its own signal cancelled (R07). */
function cancelledOnClient(): Error {
  return Object.assign(new Error("1 CANCELLED: Cancelled on client"), { code: 1, details: "Cancelled on client" });
}

/**
 * The captures a call may be answered from when no `answers` entry takes it: the service's own, but for a capture
 * split per runtime and one no member answered (a refused socket, a TLS failure, a deadline before any answer),
 * which a test reads by name only, since no request of the adapter's means one of them by its fields alone.
 */
function searchable(service: EtcdFixtureService): EtcdCapture[] {
  return ETCD_FIXTURE_NAMES.filter((name) => name.startsWith(`${service}/`) && !/\.(bun|node)$/.test(name))
    .map(etcdCapture)
    .filter((capture) => capture.$captured.memberId !== "none");
}

/** proto3 sends no default, so an absent field reads as false, 0, "" or empty bytes. */
function isDefault(expected: unknown): boolean {
  return (
    expected === false ||
    expected === "0" ||
    expected === "" ||
    expected === 0 ||
    (expected instanceof Uint8Array && expected.length === 0)
  );
}

/** Whether `actual` carries every field of `expected`: bytes by value, 64-bit integers by digits. */
function matches(expected: unknown, actual: unknown): boolean {
  if (actual === undefined || actual === null) return expected === null || isDefault(expected);
  if (expected instanceof Uint8Array) {
    return actual instanceof Uint8Array && Buffer.from(actual).equals(Buffer.from(expected));
  }
  if (typeof expected === "string") {
    return typeof actual === "string" ? actual === expected : typeof actual === "number" && String(actual) === expected;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matches(item, actual[i]))
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (typeof actual !== "object") return false;
    return Object.entries(expected).every(([key, item]) => matches(item, (actual as Record<string, unknown>)[key]));
  }
  return expected === actual;
}

/** How many fields a match names, so the most specific capture answers first. */
function leaves(value: unknown): number {
  if (value instanceof Uint8Array || value === null || typeof value !== "object") return 1;
  const items = Array.isArray(value) ? value : Object.values(value);
  return items.reduce((count: number, item) => count + leaves(item), 0);
}

/** A request as a refusal names it: bytes as base64, so the test's author can read which key it was. */
function describe(request: unknown): string {
  return JSON.stringify(request, (_, value) =>
    value !== null && typeof value === "object" && (value as { type?: unknown }).type === "Buffer"
      ? { $bytes: Buffer.from((value as { data: number[] }).data).toString("base64") }
      : value instanceof Uint8Array
        ? { $bytes: Buffer.from(value).toString("base64") }
        : value,
  );
}

/**
 * A recorded channel. A call is recorded, then answered by the next `answers[rpc]` entry, else by the searchable
 * capture of the service whose `rpc` is the call's and whose `match` the request carries, the one naming the most
 * fields first and then the first by name; a `fail` capture rejects with its Error; no match rejects naming the rpc
 * and the request, so a test never reads an answer it did not mean. A call whose signal aborts before its answer
 * rejects as grpc-js does, and a stream is chosen by its first written message.
 */
export function recordedEtcdWire(options: RecordedEtcdWireOptions = {}): RecordedEtcdWire {
  const service = options.service ?? "etcd";
  const queues = new Map(Object.entries(options.answers ?? {}).map(([rpc, list]) => [rpc, [...list]]));
  const opened: unknown[] = [];
  const calls: RecordedEtcdCall[] = [];
  const writes: Array<{ rpc: string; message: unknown }> = [];
  const cancels: string[] = [];
  let closes = 0;

  const fromCapture = (capture: EtcdCapture): unknown => {
    if (capture.outcome === "fail") throw capture.payload;
    return capture.payload;
  };

  const answer = (rpc: string, request: unknown, call: RecordedEtcdCall): unknown => {
    const queued = queues.get(rpc)?.shift();
    if (typeof queued === "function") return queued(request, call);
    if (queued !== undefined) return fromCapture(etcdCapture(queued.fixture));
    const found = searchable(service)
      .filter((capture) => capture.$captured.rpc === rpc && matches(capture.$captured.match, request))
      .sort((a, b) => leaves(b.$captured.match) - leaves(a.$captured.match))[0];
    if (found === undefined) throw new Error(`No ${service} capture answers ${rpc} ${describe(request)}`);
    return fromCapture(found);
  };

  const transport: RecordedEtcdWire["transport"] = (channelOptions) => {
    opened.push(channelOptions);
    return {
      unary(rpc, request, call) {
        const recorded: RecordedEtcdCall = { rpc, request, metadata: call.metadata, deadline: call.deadline };
        calls.push(recorded);
        return new Promise<object>((resolve, reject) => {
          const onAbort = () => reject(cancelledOnClient());
          if (call.signal.aborted) {
            onAbort();
            return;
          }
          call.signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => answer(rpc, request, recorded))
            .then(
              (value) => {
                call.signal.removeEventListener("abort", onAbort);
                resolve(value as object);
              },
              (error: unknown) => {
                call.signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
        });
      },
      stream(rpc, call) {
        let started: Promise<{ messages: unknown[]; end: unknown }> | undefined;
        let index = 0;
        let cancelled = false;
        const waiting: Array<(error: Error) => void> = [];
        const wake = () => {
          for (const reject of waiting.splice(0)) reject(cancelledOnClient());
        };
        call.signal.addEventListener("abort", wake, { once: true });
        return {
          write(message) {
            if (started !== undefined) {
              writes.push({ rpc, message });
              return;
            }
            const recorded: RecordedEtcdCall = {
              rpc,
              request: message,
              metadata: call.metadata,
              deadline: call.deadline,
            };
            calls.push(recorded);
            started = Promise.resolve().then(
              () => answer(rpc, message, recorded) as { messages: unknown[]; end: unknown },
            );
            // A rejected answer is read by read(); this keeps it from being reported as unhandled first.
            started.catch(() => undefined);
          },
          async read() {
            if (started === undefined) {
              throw new Error(
                "read() before the first write: a recorded stream is chosen by its first written message",
              );
            }
            const { messages, end } = await started;
            if (index < messages.length) return messages[index++] as object;
            if (cancelled || call.signal.aborted) throw cancelledOnClient();
            if (end === "server-end") return undefined;
            if (typeof end === "object" && end !== null && "error" in end) throw (end as { error: unknown }).error;
            return new Promise<object | undefined>((_, reject) => waiting.push(reject));
          },
          cancel() {
            if (cancelled) return;
            cancelled = true;
            cancels.push(rpc);
            wake();
          },
        };
      },
      close() {
        closes += 1;
      },
    };
  };

  return {
    transport,
    opened,
    calls,
    writes,
    cancels,
    get closes() {
      return closes;
    },
  };
}
