/**
 * Scripted transports and injected time for the Snowflake transport, rows and statements tests.
 *
 * `scriptedTransports` stands where `createNodeTransport` and `createNodeByteTransport` stand in the provider's deps.
 * Every text transport it builds is a lane, numbered from 0 in build order; the byte transport records as lane -1.
 * Every request is recorded with its method, its full URL, its headers (the connection's, then the request's own, then
 * the signer's for the byte transport, as the shared transports merge them) and its body. A request is answered by
 * the first rule added with `answer` whose method and path match and that still holds an answer; a request no rule
 * answers fails by its method and URL, so a test sees exactly its script.
 *
 * The signal and the byte caps are honoured as the shared transports honour them: a closed transport or an aborted
 * signal fails before anything is recorded, a text answer longer than `maxResponseBytes` fails as `too-large`, a byte
 * answer longer than `truncateAt` is cut and reported `truncated`, and a hanging answer fails only when its signal fires
 * or its transport closes. A `wait` answer is answered when the test resolves its promise.
 *
 * `fakeClock`, `scriptedTokens` and `testDeps` give the rest of the deps with no real timer: a clock that moves only
 * when the test or a sleep moves it, sleeps that record their delay and return at once, a fixed random value,
 * sequential UUIDs, and deadlines that fire only when the test fires them.
 */
import { createGzip } from "node:zlib";
import {
  type NodeByteRequest,
  type NodeByteResponse,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import type { SnowflakeTokenSource } from "@/lib/db/providers/sql/snowflake/auth";
import type { SnowflakeTransportDeps } from "@/lib/db/providers/sql/snowflake/transport";

export interface RecordedRequest {
  /** Which createNodeTransport call built the lane (0, 1, ...), -1 for the byte transport. */
  readonly lane: number;
  readonly method: string;
  readonly url: string;
  /** Connection headers merged with the request's own and the signer's, lower-case. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly maxResponseBytes: number;
  /** The byte request's cut, absent on a text request. */
  readonly truncateAt?: number;
}

export type ScriptedAnswer =
  | { readonly status: number; readonly text?: string; readonly json?: unknown }
  | {
      readonly status: number;
      readonly bytes: Buffer;
      readonly contentEncoding?: string | null;
      readonly truncated?: boolean;
    }
  /** Never answers until its signal aborts or its transport closes, then rejects with TransportError("aborted"). */
  | { readonly hang: true }
  /** Answers with what the promise resolves to, once the test resolves it. */
  | { readonly wait: Promise<ScriptedAnswer> }
  /** Rejects with this. */
  | { readonly fail: unknown };

interface Rule {
  readonly method?: string;
  readonly path: RegExp;
  readonly answers: ScriptedAnswer[];
}

export interface ScriptedTransports {
  readonly deps: Pick<SnowflakeTransportDeps, "createNodeTransport" | "createNodeByteTransport">;
  readonly requests: RecordedRequest[];
  /** Answers the next request whose method and URL path match; unmatched requests fail by name. */
  answer(match: { readonly method?: string; readonly path: RegExp }, ...answers: ScriptedAnswer[]): void;
  /** The lane numbers whose close() was called, in order. */
  readonly closedLanes: number[];
  readonly lanesBuilt: () => number;
  /** The options of every text transport built, in lane order. */
  readonly textOptions: NodeTransportOptions[];
  /** The options of every byte transport built. */
  readonly byteOptions: NodeByteTransportOptions[];
  /** How many times a byte transport's close() was called. */
  readonly byteCloses: () => number;
  /** Answers not yet given. */
  readonly left: () => number;
  /** Resolves once `count` requests have been recorded. */
  received(count: number): Promise<void>;
}

const CLOSED = "The transport is closed";

function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

/** A deferred answer: `wait` goes into the script, `resolve` answers it. */
export function deferredAnswer(): {
  readonly answer: ScriptedAnswer;
  resolve(answer: ScriptedAnswer): void;
} {
  let resolve: (answer: ScriptedAnswer) => void = () => {};
  const wait = new Promise<ScriptedAnswer>((done) => {
    resolve = done;
  });
  return { answer: { wait }, resolve: (answer) => resolve(answer) };
}

export function scriptedTransports(): ScriptedTransports {
  const rules: Rule[] = [];
  const requests: RecordedRequest[] = [];
  const closedLanes: number[] = [];
  const textOptions: NodeTransportOptions[] = [];
  const byteOptions: NodeByteTransportOptions[] = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  let byteCloses = 0;

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (requests.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };

  const next = (method: string, url: string): ScriptedAnswer => {
    const path = new URL(url).pathname;
    const rule = rules.find(
      (candidate) =>
        (candidate.method === undefined || candidate.method === method) &&
        candidate.path.test(path) &&
        candidate.answers.length > 0,
    );
    if (rule === undefined) throw new Error(`Unscripted request ${method} ${url}`);
    return rule.answers.shift() as ScriptedAnswer;
  };

  /** Settles one scripted answer, waiting on a hang or a deferred answer under the signal and the close. */
  const settle = async (
    answer: ScriptedAnswer,
    signal: AbortSignal,
    stops: Set<(error: TransportError) => void>,
  ): Promise<ScriptedAnswer> => {
    if ("fail" in answer) throw answer.fail;
    if (!("hang" in answer) && !("wait" in answer)) return answer;
    return new Promise<ScriptedAnswer>((resolve, reject) => {
      const stop = (error: TransportError): void => {
        stops.delete(stop);
        reject(error);
      };
      stops.add(stop);
      signal.addEventListener("abort", () => stop(abortFailure(signal)), { once: true });
      if ("wait" in answer) {
        answer.wait.then((given) => {
          stops.delete(stop);
          settle(given, signal, stops).then(resolve, reject);
        });
      }
    });
  };

  const createNodeTransport = (options: NodeTransportOptions): NodeTransport => {
    const lane = textOptions.length;
    textOptions.push(options);
    const stops = new Set<(error: TransportError) => void>();
    let closed = false;
    return {
      async request(request: NodeRequest): Promise<NodeResponse> {
        if (closed) throw new TransportError("aborted", CLOSED);
        if (request.signal.aborted) throw abortFailure(request.signal);
        requests.push({
          lane,
          method: request.method,
          url: request.url,
          headers: { ...options.headers, ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
          maxResponseBytes: request.maxResponseBytes,
        });
        notify();
        const answer = await settle(next(request.method, request.url), request.signal, stops);
        if (!("status" in answer) || "bytes" in answer) throw new Error("A text request was scripted a byte answer");
        const text = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? "");
        if (Buffer.byteLength(text) > request.maxResponseBytes) {
          throw new TransportError("too-large", "The response exceeded the limit for one response");
        }
        return { status: answer.status, contentType: "application/json", retryAfter: null, text };
      },
      close() {
        closed = true;
        closedLanes.push(lane);
        for (const stop of [...stops]) stop(new TransportError("aborted", CLOSED));
      },
    };
  };

  const createNodeByteTransport = (options: NodeByteTransportOptions): NodeByteTransport => {
    byteOptions.push(options);
    const stops = new Set<(error: TransportError) => void>();
    let closed = false;
    const origin = new URL(`${options.origin.scheme}://${options.origin.host}`);
    origin.port = String(options.origin.port);
    return {
      async request(request: NodeByteRequest): Promise<NodeByteResponse> {
        if (closed) throw new TransportError("aborted", CLOSED);
        if (request.signal.aborted) throw abortFailure(request.signal);
        const query = request.target.query === "" ? "" : `?${request.target.query}`;
        const url = `${origin.origin}${request.target.path}${query}`;
        const headers = { ...options.headers, ...request.headers, "accept-encoding": "identity" };
        const signed =
          options.signer?.sign({
            method: request.method,
            host: origin.host,
            path: request.target.path,
            query: request.target.query,
            headers: Object.freeze({ ...headers }),
            body: "",
          }) ?? {};
        requests.push({
          lane: -1,
          method: request.method,
          url,
          headers: { ...headers, ...signed },
          maxResponseBytes: request.maxResponseBytes,
          ...(request.truncateAt === undefined ? {} : { truncateAt: request.truncateAt }),
        });
        notify();
        const answer = await settle(next(request.method, url), request.signal, stops);
        if (!("bytes" in answer)) throw new Error("A byte request was scripted a text answer");
        let bytes = answer.bytes;
        let truncated = answer.truncated ?? false;
        if (request.truncateAt !== undefined && bytes.length > request.truncateAt) {
          bytes = bytes.subarray(0, request.truncateAt);
          truncated = true;
        } else if (bytes.length > request.maxResponseBytes) {
          throw new TransportError("too-large", "The response exceeded the limit for one response");
        }
        return {
          status: answer.status,
          contentType: "application/json",
          contentEncoding: answer.contentEncoding ?? null,
          retryAfter: null,
          headers: [],
          headersTruncated: false,
          bytes,
          truncated,
        };
      },
      close() {
        closed = true;
        byteCloses += 1;
        for (const stop of [...stops]) stop(new TransportError("aborted", CLOSED));
      },
    };
  };

  return {
    deps: { createNodeTransport, createNodeByteTransport },
    requests,
    answer(match, ...answers) {
      rules.push({ ...match, answers: [...answers] });
    },
    closedLanes,
    lanesBuilt: () => textOptions.length,
    textOptions,
    byteOptions,
    byteCloses: () => byteCloses,
    left: () => rules.reduce((sum, rule) => sum + rule.answers.length, 0),
    received: (count) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        notify();
      }),
  };
}

export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  readonly sleeps: number[];
  /** Records `ms`, moves the clock by it and resolves at once; rejects with the reason if the signal already aborted. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const SNOWFLAKE_TEST_START = Date.UTC(2026, 9, 12, 2, 0, 0);

export function fakeClock(start: number = SNOWFLAKE_TEST_START): FakeClock {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    sleeps,
    sleep(ms, signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

export interface ScriptedTokens extends SnowflakeTokenSource {
  /** Moves `token()` to the next token of the list. */
  advance(): void;
  /** Holds every later `token()` call until the returned release runs. */
  hold(): () => void;
  /** How many times `token()` was called. */
  calls(): number;
}

export function scriptedTokens(
  tokens: string[],
  tokenType: "KEYPAIR_JWT" | "PROGRAMMATIC_ACCESS_TOKEN" = "KEYPAIR_JWT",
): ScriptedTokens {
  let index = 0;
  let calls = 0;
  let held: Promise<void> | null = null;
  return {
    tokenType,
    async token() {
      calls += 1;
      if (held !== null) await held;
      return tokens[index] as string;
    },
    advance() {
      index += 1;
    },
    hold() {
      let release: () => void = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
    calls: () => calls,
  };
}

/** The n-th UUID `newId` gives, from 1. */
export function snowflakeTestUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export interface TestDeadlines {
  /** Every `deadline(ms)` asked for, in order. */
  readonly requested: number[];
  /** Fires the index-th deadline with the `TimeoutError` reason `AbortSignal.timeout()` gives. */
  fire(index: number): void;
}

/** The deps with no real timer: random 0.5, sequential UUIDs, and deadlines the test fires. */
export function testDeps(
  transports: ScriptedTransports,
  clock: FakeClock,
): SnowflakeTransportDeps & { readonly deadlines: TestDeadlines } {
  let ids = 0;
  const controllers: AbortController[] = [];
  const requested: number[] = [];
  return {
    ...transports.deps,
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    random: () => 0.5,
    newId: () => snowflakeTestUuid(++ids),
    deadline(ms) {
      const controller = new AbortController();
      controllers.push(controller);
      requested.push(ms);
      return controller.signal;
    },
    deadlines: {
      requested,
      fire(index) {
        controllers[index]?.abort(new DOMException("The operation timed out.", "TimeoutError"));
      },
    },
  };
}

/**
 * A gzip body of about `decodedBytes` decoded bytes of `[["000...0"],...,["0"]]`, each cell `cellWidth` zeros, built
 * through `createGzip({ level: 9 })` in 1 MiB slices so the decoded text is never held whole: 1 GiB compresses to
 * about 2 MB. The default width makes each row 1,005 bytes with its comma, so the byte budget, not the row cut, ends it.
 */
export async function gzipRowsBomb(decodedBytes: number, cellWidth = 1_000): Promise<Buffer> {
  const row = `["${"0".repeat(cellWidth)}"],`;
  const slice = Buffer.from(row.repeat(Math.max(1, Math.floor(1_048_576 / row.length))));
  const gzip = createGzip({ level: 9 });
  const out: Buffer[] = [];
  gzip.on("data", (chunk: Buffer) => out.push(chunk));
  const ended = new Promise<void>((resolve) => gzip.on("end", () => resolve()));
  const write = (bytes: Buffer): Promise<void> =>
    new Promise((resolve) => {
      if (gzip.write(bytes)) resolve();
      else gzip.once("drain", () => resolve());
    });
  await write(Buffer.from("["));
  for (let written = 1; written < decodedBytes; written += slice.length) {
    // oxlint-disable-next-line no-await-in-loop -- one slice at a time, so the decoded text is never held whole.
    await write(slice);
  }
  gzip.end(Buffer.from('["0"]]'));
  await ended;
  return Buffer.concat(out);
}
