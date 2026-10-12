/**
 * Fake FirestoreSeams for the Firestore unit tests: every transport the code under test builds is recorded with its
 * lane and options, every request is answered from memory, and the clock, deadlines, environment and files are
 * fixed, so no test opens a socket, reads a real variable or file, or waits on a timer.
 *
 * A request settles the way the shared node transport settles one: its signal aborting rejects it with a
 * TransportError of kind "timeout" when the reason is a TimeoutError DOMException and "aborted" otherwise, and
 * close() rejects every request still in flight with kind "aborted".
 *
 * sleep records its milliseconds and resolves at once, or rejects with the signal's reason when the signal is
 * already aborted, as the real sleep does; it never waits, so an abort during a sleep cannot be staged through it.
 */
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import type { FirestoreEnv, FirestoreSeams, LaneKind } from "@/lib/db/providers/document/firestore/seams";

export type FirestoreAnswer = (request: NodeRequest, lane: LaneKind) => NodeResponse | Promise<NodeResponse>;

export interface FakeLane {
  readonly lane: LaneKind;
  readonly options: NodeTransportOptions;
  readonly requests: NodeRequest[];
  /** Every TransportError a request on this lane was rejected with, in order. */
  readonly failures: TransportError[];
  closed: number;
}

export interface FakeDeadline {
  readonly ms: number;
  readonly controller: AbortController;
}

export interface FakeFirestoreSeams extends FirestoreSeams {
  readonly lanes: FakeLane[];
  /** Every environment variable name read, in order, repeats included. */
  readonly envReads: string[];
  readonly fileReads: string[];
  readonly deadlines: FakeDeadline[];
  readonly sleeps: number[];
  setClock(ms: number): void;
  lanesOf(kind: LaneKind): FakeLane[];
  /** Aborts the deadline signal at `index` with a TimeoutError DOMException, as AbortSignal.timeout does. */
  fireDeadline(index: number): void;
}

export interface FakeSeamsOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, string>>;
  /** A path whose read throws an Error carrying this errno code. */
  readonly fileErrors?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly platform?: string;
  readonly now?: number;
  readonly answer?: FirestoreAnswer;
}

export const FIXED_NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

export function jsonAnswer(body: unknown, status = 200, retryAfter: string | null = null): NodeResponse {
  return { status, contentType: "application/json", retryAfter, text: JSON.stringify(body) };
}

export function tokenAnswer(token: string, expiresIn = 3600): NodeResponse {
  return jsonAnswer({ access_token: token, expires_in: expiresIn, token_type: "Bearer" });
}

/** A promise the test settles by hand. */
export function held<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve(value) };
}

function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "fake deadline")
    : new TransportError("aborted", "fake cancel");
}

export function fakeSeams(options: FakeSeamsOptions = {}): FakeFirestoreSeams {
  const lanes: FakeLane[] = [];
  const envReads: string[] = [];
  const fileReads: string[] = [];
  const deadlines: FakeDeadline[] = [];
  const sleeps: number[] = [];
  let clock = options.now ?? FIXED_NOW;
  const answer: FirestoreAnswer = options.answer ?? (() => jsonAnswer({}));
  const env: FirestoreEnv = new Proxy(Object.freeze({ ...options.env }), {
    get(target, name) {
      if (typeof name === "string") envReads.push(name);
      return Reflect.get(target, name);
    },
  });

  const createTransport = (transportOptions: NodeTransportOptions, lane: LaneKind): NodeTransport => {
    const entry: FakeLane = { lane, options: transportOptions, requests: [], failures: [], closed: 0 };
    lanes.push(entry);
    const inFlight = new Set<(error: TransportError) => void>();
    return {
      request(request) {
        entry.requests.push(request);
        return new Promise<NodeResponse>((resolve, reject) => {
          let settled = false;
          const settle = () => {
            settled = true;
            inFlight.delete(fail);
            request.signal.removeEventListener("abort", onAbort);
          };
          const fail = (error: TransportError) => {
            if (settled) return;
            settle();
            entry.failures.push(error);
            reject(error);
          };
          const onAbort = () => fail(abortFailure(request.signal));
          if (request.signal.aborted) {
            onAbort();
            return;
          }
          inFlight.add(fail);
          request.signal.addEventListener("abort", onAbort, { once: true });
          Promise.resolve()
            .then(() => answer(request, lane))
            .then(
              (response) => {
                if (settled) return;
                settle();
                resolve(response);
              },
              (error: unknown) => {
                if (error instanceof TransportError) {
                  fail(error);
                  return;
                }
                if (settled) return;
                settle();
                reject(error);
              },
            );
        });
      },
      close() {
        entry.closed += 1;
        for (const fail of [...inFlight]) fail(new TransportError("aborted", "fake transport closed"));
      },
    };
  };

  return {
    createTransport,
    now: () => clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal?.aborted) throw signal.reason;
    },
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    },
    env,
    readFile: (path) => {
      fileReads.push(path);
      const code = options.fileErrors?.[path];
      if (code !== undefined) throw Object.assign(new Error(`fake ${code}`), { code });
      const text = options.files?.[path];
      if (text === undefined) throw Object.assign(new Error("fake ENOENT"), { code: "ENOENT" });
      return text;
    },
    homeDir: () => options.home ?? "/home/studio",
    platform: options.platform ?? "linux",
    lanes,
    envReads,
    fileReads,
    deadlines,
    sleeps,
    setClock: (ms) => {
      clock = ms;
    },
    lanesOf: (kind) => lanes.filter((lane) => lane.lane === kind),
    fireDeadline: (index) => deadlines[index].controller.abort(new DOMException("deadline", "TimeoutError")),
  };
}
