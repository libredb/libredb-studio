/**
 * Neutral fakes for the tests of src/lib/db/auth: the IO a credential chain reads through (environment, files with
 * errno codes, home directory, platform), a clock with hand-fired deadlines, and a transport factory that records
 * every lane it builds with its options and requests and answers each request from a script.
 *
 * It imports nothing from a provider, so a shared test never leans on one provider's helper.
 *
 * A request settles the way the shared node transport settles one: its signal aborting rejects it with a
 * TransportError of kind "timeout" when the reason is a TimeoutError DOMException and "aborted" otherwise, and
 * close() rejects every request still in flight with kind "aborted".
 */
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";

export const FIXED_NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

export interface FakeIoOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly files?: Readonly<Record<string, string>>;
  /** A path whose read throws an Error carrying this errno code. */
  readonly fileErrors?: Readonly<Record<string, string>>;
  readonly home?: string;
  readonly platform?: string;
}

export interface FakeIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readFile(path: string): string;
  homeDir(): string;
  readonly platform: string;
  /** Every environment variable name read, in order, repeats included. */
  readonly envReads: string[];
  readonly fileReads: string[];
}

/** An IO whose environment and files are the ones given; any other path is absent (ENOENT). */
export function fakeIo(options: FakeIoOptions = {}): FakeIo {
  const envReads: string[] = [];
  const fileReads: string[] = [];
  const env = new Proxy(Object.freeze({ ...options.env }), {
    get(target, name) {
      if (typeof name === "string") envReads.push(name);
      return Reflect.get(target, name);
    },
  });
  return {
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
    envReads,
    fileReads,
  };
}

export interface FakeDeadline {
  readonly ms: number;
  readonly controller: AbortController;
}

export interface FakeClock {
  now(): number;
  timeoutSignal(ms: number): AbortSignal;
  setClock(ms: number): void;
  readonly deadlines: FakeDeadline[];
  /** Aborts the deadline signal at `index` with a TimeoutError DOMException, as AbortSignal.timeout does. */
  fireDeadline(index: number): void;
}

export function fakeClock(start = FIXED_NOW): FakeClock {
  let clock = start;
  const deadlines: FakeDeadline[] = [];
  return {
    now: () => clock,
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    },
    setClock: (ms) => {
      clock = ms;
    },
    deadlines,
    fireDeadline: (index) => deadlines[index].controller.abort(new DOMException("deadline", "TimeoutError")),
  };
}

export type FakeAnswer<L extends string> = (request: NodeRequest, lane: L) => NodeResponse | Promise<NodeResponse>;

export interface FakeLane<L extends string> {
  readonly lane: L;
  readonly options: NodeTransportOptions;
  readonly requests: NodeRequest[];
  closed: number;
}

export interface FakeTransports<L extends string> {
  createTransport(options: NodeTransportOptions, lane: L): NodeTransport;
  readonly lanes: FakeLane<L>[];
  lanesOf(lane: L): FakeLane<L>[];
}

export function jsonAnswer(body: unknown, status = 200): NodeResponse {
  return { status, contentType: "application/json", retryAfter: null, text: JSON.stringify(body) };
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

/** A transport factory whose every transport is recorded and answered by `answer`. */
export function fakeTransports<L extends string>(answer: FakeAnswer<L> = () => jsonAnswer({})): FakeTransports<L> {
  const lanes: FakeLane<L>[] = [];
  const createTransport = (options: NodeTransportOptions, lane: L): NodeTransport => {
    const entry: FakeLane<L> = { lane, options, requests: [], closed: 0 };
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
  return { createTransport, lanes, lanesOf: (lane) => lanes.filter((entry) => entry.lane === lane) };
}
