/**
 * The recorded wire: the one test seam below the Oxia adapter (SB1-5.5a, SB3-5.5, contract section 20.4).
 *
 * Two halves. `recordedOxiaWire` replays: it implements `OxiaWireTransport`, so the real adapter runs over it, logs
 * every channel it opens and every call it makes (the target, the TLS identity, whether the token went with it), and
 * answers each call from a recorded or synthetic call; a call nothing matches fails. `recordingOxiaWire` records: it
 * wraps a real transport and writes what it carried in the same capture shape, for the evidence harness.
 * Tests above the adapter use tests/helpers/oxia-fake-client.ts instead.
 *
 * It imports no gRPC package: it implements `GrpcChannel` structurally, and the recorder measures a message with the
 * method's own `responseSerialize`. No capture and no log entry holds a token, a certificate or a key: the token is
 * recorded as a boolean, and a channel's TLS options as their mode and identity alone.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  GrpcCall,
  GrpcChannel,
  GrpcChannelConfig,
  GrpcServerStream,
  GrpcServerStreamLimits,
} from "@/lib/db/grpc/channel";
import type { OxiaWireTransport } from "@/lib/db/providers/keyvalue/oxia/grpc-client";

/** The TLS options a channel was opened with, as the transport received them: mode and identity, no key material. */
export interface WireTls {
  /** "disable" for a plaintext channel, else GrpcTlsOptions.mode. */
  readonly mode: string;
  /** GrpcTlsOptions.identity: the host the channel checks the certificate against. */
  readonly identity?: string;
}

export type OxiaWireMethod =
  | "io.oxia.proto.v1.OxiaClient/GetShardAssignments"
  | "io.oxia.proto.v1.OxiaClient/Read"
  | "io.oxia.proto.v1.OxiaClient/List"
  | "io.oxia.proto.v1.OxiaClient/RangeScan"
  | "grpc.health.v1.Health/Check";

/** How a recorded call ended: a status, or still open (the server held it open, or the client ended it first). */
export type RecordedEnd =
  | { readonly kind: "status"; readonly code: number; readonly details: string; readonly errorInfo?: string }
  | { readonly kind: "open" };

/** One recorded server stream or unary call, as `tests/live/oxia-evidence.ts` writes it. */
export interface RecordedCall {
  /** "127.0.0.1:6648": the channel's dial target without its "dns:" prefix. */
  readonly target: string;
  /** The :authority the client sent: the same host:port. */
  readonly authority: string;
  readonly method: OxiaWireMethod;
  /** The decoded request, matched canonically (sorted keys). */
  readonly request: unknown;
  /** Decoded responses, in order. */
  readonly messages: readonly unknown[];
  /** The serialized length of each message, in order, so a replayed stream honours `maxReceivedBytes` as the real one did. */
  readonly messageBytes: readonly number[];
  readonly end: RecordedEnd;
  /** Whether the recorded call carried the `authorization` header. Never matched on. */
  readonly token?: boolean;
  /** The TLS options of the channel that carried the recorded call. Never matched on. */
  readonly tls?: WireTls;
}

export interface OxiaCapture {
  /** Path under tests/fixtures/oxia/, forward slashes. */
  readonly file: string;
  /** Of the file's bytes. */
  readonly sha256: string;
  readonly calls: readonly RecordedCall[];
  /** What the recorded run answered, as the evidence harness summarised it; the integration test compares its replay with it. */
  readonly result?: unknown;
}

export type WireEvent =
  | { readonly kind: "open"; readonly target: string; readonly tls: WireTls }
  | {
      readonly kind: "call";
      readonly target: string;
      readonly authority: string;
      readonly method: OxiaWireMethod;
      readonly request: unknown;
      readonly token: boolean;
    }
  | {
      readonly kind: "cancel";
      readonly target: string;
      readonly method: OxiaWireMethod;
      readonly afterMessages: number;
    }
  | { readonly kind: "close"; readonly target: string };

/** A call the client made that no recorded call matched. */
export interface UnmatchedCall {
  readonly target: string;
  readonly method: string;
  readonly request: unknown;
}

export interface RecordedOxiaWire {
  /** Passed to `createGrpcOxiaClient`; a call no recorded call matches fails, never answers. */
  readonly transport: OxiaWireTransport;
  /** Which addresses were dialled with which TLS identity, and which calls carried the token. */
  readonly log: readonly WireEvent[];
  /** Recorded calls never matched, so an unused answer fails the test. */
  readonly unused: () => readonly RecordedCall[];
  /** The calls the client made that nothing matched, so a test can assert there were none. */
  readonly unmatched: () => readonly UnmatchedCall[];
}

/** What `syntheticCall` takes: a recorded call whose authority and message sizes may be left out. */
export type SyntheticCallInput = Omit<RecordedCall, "authority" | "messageBytes"> & {
  readonly authority?: string;
  readonly messageBytes?: readonly number[];
};

/** The recorder: a transport to hand the adapter, and the capture of what it carried. */
export interface RecordingOxiaWire {
  readonly transport: OxiaWireTransport;
  capture(file: string, result?: unknown): OxiaCapture;
}

type WireMethodDefinition = Parameters<GrpcChannel["unary"]>[0];

/** The status error's metadata, as the adapter and grpc-js read it. */
interface StatusMetadata {
  get(key: string): unknown[];
}

/** A rejection as the recorder reads it: a grpc-js status error. */
interface StatusFailure {
  readonly code: number;
  readonly details: string;
  readonly metadata?: StatusMetadata;
}

/** One pending read or unary call. */
interface Waiter {
  resolve(value: object | undefined): void;
  reject(error: Error): void;
}

/** What a replayed call needs of its channel. */
interface ReplayChannel {
  readonly target: string;
  readonly log: WireEvent[];
  readonly open: Set<ReplayCall>;
}

/** One call the recorder is writing; `end` is set when the call ends. */
interface Recording {
  readonly target: string;
  readonly method: OxiaWireMethod;
  readonly request: unknown;
  readonly token: boolean;
  readonly tls: WireTls;
  readonly messages: unknown[];
  readonly messageBytes: number[];
  end?: RecordedEnd;
}

/** One recorded call of the replay, its match key, and whether a call took it. */
interface ReplayEntry {
  readonly call: RecordedCall;
  readonly key: string;
  taken: boolean;
}

const OXIA_WIRE_METHODS: readonly string[] = [
  "io.oxia.proto.v1.OxiaClient/GetShardAssignments",
  "io.oxia.proto.v1.OxiaClient/Read",
  "io.oxia.proto.v1.OxiaClient/List",
  "io.oxia.proto.v1.OxiaClient/RangeScan",
  "grpc.health.v1.Health/Check",
] satisfies OxiaWireMethod[];
/** The length from which bytes that are one repeated value are written as { $filled } (the etcd evidence harness's rule). */
const FILLED_FROM = 65_536;
const FIXTURE_DIRECTORY = path.join(import.meta.dirname, "..", "fixtures", "oxia");
const DETAILS_TRAILER = "grpc-status-details-bin";
const CANCELLED = 1;
const DEADLINE_EXCEEDED = 4;
const OK_END: RecordedEnd = { kind: "status", code: 0, details: "" };
const OPEN_END: RecordedEnd = { kind: "open" };

function encodeBytes(value: Uint8Array): unknown {
  const first = value[0] as number;
  if (value.length >= FILLED_FROM && value.every((byte) => byte === first)) {
    return { $filled: { byte: first, length: value.length } };
  }
  return { $bytes: Buffer.from(value).toString("base64") };
}

/** Object keys sorted at every depth, bytes as { $bytes } or { $filled }, everything else as JSON writes it. */
function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(fields)
        .sort()
        .map((key) => [key, canonical(fields[key])]),
    );
  }
  return value;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** Every { $bytes } and { $filled } of a parsed capture as the `Buffer` OXIA_LOADER_OPTIONS decodes a bytes field to. */
function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    const keys = Object.keys(fields);
    if (keys.length === 1 && typeof fields.$bytes === "string") return Buffer.from(fields.$bytes, "base64");
    if (keys.length === 1 && keys[0] === "$filled") {
      const filled = fields.$filled as { readonly byte: number; readonly length: number };
      return Buffer.alloc(filled.length, filled.byte);
    }
    return Object.fromEntries(keys.map((key) => [key, revive(fields[key])]));
  }
  return value;
}

function bareTarget(config: GrpcChannelConfig): string {
  return config.target.startsWith("dns:") ? config.target.slice("dns:".length) : config.target;
}

function wireTls(config: GrpcChannelConfig): WireTls {
  return config.tls === undefined ? { mode: "disable" } : { mode: config.tls.mode, identity: config.tls.identity };
}

function carriesToken(call: GrpcCall): boolean {
  return Object.keys(call.metadata).some((key) => key.toLowerCase() === "authorization");
}

function methodName(method: WireMethodDefinition): string {
  return method.path.startsWith("/") ? method.path.slice(1) : method.path;
}

/** The status error the adapter's `toOxiaError` reads: `code`, `details`, and the details trailer. */
function statusError(code: number, details: string, errorInfo?: string): Error {
  const metadata: StatusMetadata = {
    get: (key) => (key === DETAILS_TRAILER && errorInfo !== undefined ? [Buffer.from(errorInfo, "base64")] : []),
  };
  return Object.assign(new Error(details), { code, details, metadata });
}

function endError(end: Extract<RecordedEnd, { kind: "status" }>): Error {
  return statusError(end.code, end.details, end.errorInfo);
}

/**
 * The life of one replayed call that can wait: its pending reads, the deadline timer, the abort listener and its one
 * cancel event. Terminal once ended (reads answer undefined) or failed (reads reject).
 */
class ReplayCall {
  delivered = 0;
  private readonly waiters: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | undefined;
  private ended = false;
  private cancelLogged = false;
  private readonly onAbort = (): void => this.fail(statusError(CANCELLED, "Cancelled on client"), true);

  constructor(
    private readonly channel: ReplayChannel,
    private readonly method: OxiaWireMethod,
    private readonly call: GrpcCall,
  ) {
    channel.open.add(this);
    if (call.signal.aborted) this.onAbort();
    else call.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  get terminal(): boolean {
    return this.ended || this.failure !== undefined;
  }

  /** Answers undefined once ended, rejects once failed, else waits for an abort, a close or the deadline. */
  wait(): Promise<object | undefined> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(undefined);
    this.timer ??= setTimeout(
      () => this.fail(statusError(DEADLINE_EXCEEDED, "Deadline exceeded"), false),
      Math.max(0, this.call.deadline.getTime() - Date.now()),
    );
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** The client ended it: one cancel event, and every pending and later read answers undefined. */
  cancel(): void {
    if (this.terminal) return;
    this.ended = true;
    this.logCancel();
    for (const waiter of this.release()) waiter.resolve(undefined);
  }

  /** The server ended it with status 0: later reads answer undefined, and no cancel is logged. */
  finish(): void {
    this.ended = true;
    this.release();
  }

  fail(error: Error, logCancel: boolean): void {
    if (this.terminal) return;
    this.failure = error;
    if (logCancel) this.logCancel();
    for (const waiter of this.release()) waiter.reject(error);
  }

  private logCancel(): void {
    if (this.cancelLogged) return;
    this.cancelLogged = true;
    this.channel.log.push({
      kind: "cancel",
      target: this.channel.target,
      method: this.method,
      afterMessages: this.delivered,
    });
  }

  /** Clears the timer and the listener, leaves the channel's open set, and hands back the waiters. */
  private release(): Waiter[] {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.call.signal.removeEventListener("abort", this.onAbort);
    this.channel.open.delete(this);
    return this.waiters.splice(0);
  }
}

/** A stream whose every read rejects with `error`: the answer to a call nothing matched. */
function failedStream(error: Error): GrpcServerStream {
  return {
    read: () => Promise.reject(error),
    receivedBytes: 0,
    truncated: false,
    cancel: () => {},
  };
}

/** A replayed server stream over one recorded call (SB1-3.3 rule 1a at its byte limit). */
function replayStream(life: ReplayCall, recorded: RecordedCall, limits: GrpcServerStreamLimits): GrpcServerStream {
  let receivedBytes = 0;
  let truncated = false;
  return {
    read: async () => {
      if (life.terminal) return life.wait();
      if (receivedBytes >= limits.maxReceivedBytes) {
        truncated = true;
        life.cancel();
        return undefined;
      }
      if (life.delivered < recorded.messages.length) {
        const message = recorded.messages[life.delivered] as object;
        receivedBytes += recorded.messageBytes[life.delivered] ?? 0;
        life.delivered += 1;
        return message;
      }
      const end = recorded.end;
      if (end.kind === "open") return life.wait();
      if (end.code === 0) {
        life.finish();
        return undefined;
      }
      life.fail(endError(end), false);
      return life.wait();
    },
    get receivedBytes() {
      return receivedBytes;
    },
    get truncated() {
      return truncated;
    },
    cancel: () => {
      if (life.terminal) return;
      truncated = true;
      life.cancel();
    },
  };
}

/** The replay: every channel and call logged, every call answered from the captures or failed. */
export function recordedOxiaWire(captures: readonly OxiaCapture[]): RecordedOxiaWire {
  const log: WireEvent[] = [];
  const unmatched: UnmatchedCall[] = [];
  const entries: ReplayEntry[] = captures
    .flatMap((capture) => capture.calls)
    .map((call) => ({ call, key: canonicalText([call.target, call.method, call.request]), taken: false }));
  const taken = new Map<string, number>();

  /** The recorded call that answers this one: the n-th call of a key takes the n-th recorded call, then the last. */
  const match = (target: string, method: string, request: unknown): RecordedCall | undefined => {
    const key = canonicalText([target, method, request]);
    const matching = OXIA_WIRE_METHODS.includes(method) ? entries.filter((entry) => entry.key === key) : [];
    if (matching.length === 0) {
      unmatched.push({ target, method, request });
      return undefined;
    }
    const count = taken.get(key) ?? 0;
    taken.set(key, count + 1);
    const entry = matching[Math.min(count, matching.length - 1)] as ReplayEntry;
    entry.taken = true;
    return entry.call;
  };

  /** Logs the call, then answers its recorded call or the error of a call nothing matched. */
  const begin = (channel: ReplayChannel, method: WireMethodDefinition, request: object, call: GrpcCall) => {
    const name = methodName(method);
    // A path outside OxiaWireMethod is logged as it was called; it can never match.
    const logged = name as OxiaWireMethod;
    const { target } = channel;
    log.push({ kind: "call", target, authority: target, method: logged, request, token: carriesToken(call) });
    const recorded = match(target, name, request);
    const failure =
      recorded === undefined
        ? new Error(`oxia-wire: no recorded call for ${name} on ${target}: ${canonicalText(request)}`)
        : undefined;
    return { recorded, failure, method: logged };
  };

  const transport: OxiaWireTransport = {
    channel: (_address, config) => {
      const channel: ReplayChannel = { target: bareTarget(config), log, open: new Set() };
      log.push({ kind: "open", target: channel.target, tls: wireTls(config) });
      return {
        unary: async (method, request, call) => {
          const { recorded, failure, method: name } = begin(channel, method, request, call);
          if (recorded === undefined) throw failure;
          const end = recorded.end;
          if (end.kind === "open") return new ReplayCall(channel, name, call).wait() as Promise<object>;
          if (end.code !== 0) throw endError(end);
          return recorded.messages[0] as object;
        },
        bidiStream: () => {
          throw new Error("oxia-wire: the Oxia adapter opens no bidirectional stream");
        },
        serverStream: (method, request, call, limits) => {
          if (!Number.isInteger(limits.maxReceivedBytes) || limits.maxReceivedBytes < 1) {
            throw new RangeError("maxReceivedBytes must be a whole number of at least 1");
          }
          const { recorded, failure, method: name } = begin(channel, method, request, call);
          if (recorded === undefined) return failedStream(failure as Error);
          return replayStream(new ReplayCall(channel, name, call), recorded, limits);
        },
        close: () => {
          for (const life of [...channel.open]) life.fail(statusError(CANCELLED, "Cancelled on client"), true);
          log.push({ kind: "close", target: channel.target });
        },
      };
    },
  };

  return {
    transport,
    log,
    unused: () => entries.filter((entry) => !entry.taken).map((entry) => entry.call),
    unmatched: () => unmatched,
  };
}

/** Synthetic answers for paths no capture can reach (F11 d): leaders outside the policy, a malformed snapshot. */
export function syntheticCall(call: SyntheticCallInput): RecordedCall {
  return {
    ...call,
    authority: call.authority ?? call.target,
    messageBytes: call.messageBytes ?? call.messages.map((message) => Buffer.byteLength(canonicalText(message))),
  };
}

/** A capture built in a test from synthetic calls. */
export function syntheticCapture(calls: readonly RecordedCall[]): OxiaCapture {
  return { file: "synthetic", sha256: "", calls };
}

/** The digest README.md's table records for `file`, or undefined when no row names it. */
function recordedDigest(directory: string, file: string): string | undefined {
  const readme = path.join(directory, "README.md");
  if (!existsSync(readme)) return undefined;
  for (const line of readFileSync(readme, "utf8").split("\n")) {
    const cells = line.split("|").map((cell) => cell.trim());
    if (line.trimStart().startsWith("|") && cells[1] === file) return cells[2];
  }
  return undefined;
}

/** Reads tests/fixtures/oxia/<file> (or `directory`/<file>), revives bytes, and checks the file's SHA-256 against the README's table. */
export function loadOxiaCapture(file: string, directory: string = FIXTURE_DIRECTORY): OxiaCapture {
  const bytes = readFileSync(path.join(directory, file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const recorded = recordedDigest(directory, file);
  if (recorded === undefined) throw new Error(`oxia-wire: ${file} is not in tests/fixtures/oxia/README.md`);
  if (recorded !== sha256) throw new Error(`oxia-wire: ${file} does not match the digest README.md records`);
  const parsed = revive(JSON.parse(bytes.toString("utf8"))) as Omit<OxiaCapture, "sha256">;
  return { ...parsed, sha256 };
}

function statusEnd(error: unknown): RecordedEnd {
  const status = error as StatusFailure;
  const trailer = status.metadata?.get(DETAILS_TRAILER)[0];
  return {
    kind: "status",
    code: status.code,
    details: status.details,
    ...(Buffer.isBuffer(trailer) ? { errorInfo: trailer.toString("base64") } : {}),
  };
}

/** Wraps a real transport and records every call it carries, in the capture shape; the evidence harness's recorder. */
export function recordingOxiaWire(inner: OxiaWireTransport): RecordingOxiaWire {
  const recordings: Recording[] = [];

  const start = (config: GrpcChannelConfig, method: WireMethodDefinition, request: object, call: GrpcCall) => {
    const recording: Recording = {
      target: bareTarget(config),
      method: methodName(method) as OxiaWireMethod,
      request,
      token: carriesToken(call),
      tls: wireTls(config),
      messages: [],
      messageBytes: [],
    };
    recordings.push(recording);
    const delivered = (message: object): void => {
      recording.messages.push(message);
      recording.messageBytes.push(method.responseSerialize(message).length);
    };
    return { recording, delivered };
  };

  const transport: OxiaWireTransport = {
    channel: (address, config) => {
      const channel = inner.channel(address, config);
      return {
        unary: async (method, request, call) => {
          const { recording, delivered } = start(config, method, request, call);
          try {
            const answer = await channel.unary(method, request, call);
            delivered(answer);
            recording.end = OK_END;
            return answer;
          } catch (error) {
            recording.end = statusEnd(error);
            throw error;
          }
        },
        bidiStream: (method, call) => channel.bidiStream(method, call),
        serverStream: (method, request, call, limits) => {
          const stream = channel.serverStream(method, request, call, limits);
          const { recording, delivered } = start(config, method, request, call);
          return {
            read: async () => {
              let message: object | undefined;
              try {
                message = await stream.read();
              } catch (error) {
                recording.end ??= statusEnd(error);
                throw error;
              }
              if (message === undefined) recording.end ??= stream.truncated ? OPEN_END : OK_END;
              else delivered(message);
              return message;
            },
            get receivedBytes() {
              return stream.receivedBytes;
            },
            get truncated() {
              return stream.truncated;
            },
            cancel: () => {
              stream.cancel();
              recording.end ??= OPEN_END;
            },
          };
        },
        close: () => channel.close(),
      };
    },
  };

  const capture = (file: string, result?: unknown): OxiaCapture => {
    const calls: RecordedCall[] = [];
    const seen = new Set<string>();
    for (const recording of recordings) {
      const { target, method, request, token, tls } = recording;
      const messages = [...recording.messages];
      const end = recording.end ?? OPEN_END;
      const key = canonicalText([target, method, request, messages, end]);
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push({
        target,
        authority: target,
        method,
        request,
        messages,
        messageBytes: [...recording.messageBytes],
        end,
        token,
        tls,
      });
    }
    const body = { file, calls, ...(result === undefined ? {} : { result }) };
    return { ...body, sha256: createHash("sha256").update(serializeOxiaCapture(body)).digest("hex") };
  };

  return { transport, capture };
}

/**
 * A capture's JSON text: keys sorted, two-space indent, LF, one trailing newline; bytes as `{ "$bytes": "<base64>" }`,
 * or as `{ "$filled": { "byte": n, "length": n } }` when they are 65,536 or more bytes of one repeated value.
 */
export function serializeOxiaCapture(capture: Omit<OxiaCapture, "sha256">): string {
  const members = {
    file: capture.file,
    calls: capture.calls,
    ...(capture.result === undefined ? {} : { result: capture.result }),
  };
  return `${JSON.stringify(canonical(members), null, 2)}\n`;
}
