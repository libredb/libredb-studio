/**
 * A scripted `NodeTransport` and injected time for the Databend HTTP transport tests (design section 9; X16).
 *
 * `scriptedNodeTransport` stands where `createNodeTransport` stands in `createDatabendHttpTransport`'s deps. It holds
 * a queue of expected requests, each a method, a path and the reply it gets, and records every request it receives:
 * its method, URL, path, headers (the connection's, then the request's own, merged as the shared transport merges
 * them) and body. A request that is not the next one expected is recorded as a mismatch and fails, so a test that
 * ends with `expectDone()` has seen exactly its script. The signal and the byte cap are honoured as the shared
 * transport honours them: an already-aborted signal fails before anything is recorded, a reply longer than
 * `maxResponseBytes` fails as `too-large`, and a hanging reply fails only when its signal fires.
 *
 * `transportDeps` gives the rest of the deps with no real timer: a clock that moves only when the test or an injected
 * sleep moves it, sleeps that record their delay and return at once, a fixed random value, sequential UUIDs, and
 * deadlines that fire only when the test fires them, with the `TimeoutError` reason `AbortSignal.timeout()` gives.
 *
 * `capturedAnswer` replays a body of the committed local captures (tests/fixtures/databend/), its placeholders
 * replaced by the test's own ids.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import { type AuthLatch, createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import {
  buildDatabendConnectionOptions,
  type DatabendConnectionOptions,
} from "@/lib/db/providers/sql/databend/connection-options";
import {
  createDatabendHttpTransport,
  type DatabendHttpTransportDeps,
} from "@/lib/db/providers/sql/databend/http-transport";
import type { DatabendTransport, StatementOrigin, StatementRequest } from "@/lib/db/providers/sql/databend/transport";
import { type DatabaseConnection, TUNNEL_FAR_END, TUNNEL_ROUTE, type TunnelFarEnd } from "@/lib/types";
import { ALLOWS_PRIVATE_HOSTS } from "./egress-decisions";

const CAPTURES = join(import.meta.dir, "..", "fixtures", "databend", "local-2026-10-08-v1.2.951-nightly");

export interface RecordedRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  /** The URL's path, the part a script names. */
  readonly path: string;
  /** The connection's headers, then the request's own. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** What a scripted request gets: an answer, a transport failure, or nothing until its signal fires. */
export type ScriptedReply =
  | {
      readonly status: number;
      /** Text as given; anything else is serialised with JSON.stringify. Empty when absent. */
      readonly body?: unknown;
      /** `application/json` when absent. */
      readonly contentType?: string | null;
      readonly retryAfter?: string;
    }
  | { readonly fail: TransportError["kind"]; readonly truncated?: boolean }
  /** Thrown as it is, as the shared transport throws a refusal of its own before any socket. */
  | { readonly throws: Error }
  | { readonly hang: true };

export interface ScriptedStep {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly reply: ScriptedReply | ((request: RecordedRequest) => ScriptedReply);
}

/** The shared transport's failure for an aborted signal: a deadline or a cancellation, told apart by the reason. */
function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

function bodyText(body: unknown): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

export interface ScriptedNodeTransport {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  /** Every request received, in order, mismatches included. */
  readonly requests: RecordedRequest[];
  /** The options of every transport the factory built. */
  readonly built: NodeTransportOptions[];
  /** Requests that were not the next one expected. */
  readonly mismatches: string[];
  /** How many times close() was called. */
  closes(): number;
  /** Steps not yet taken. */
  left(): number;
  /** Adds steps to the end of the queue. */
  push(...steps: ScriptedStep[]): void;
  /** Resolves once `count` requests have been received. */
  received(count: number): Promise<void>;
  /** Asserts every step was taken and nothing else was asked. */
  expectDone(): void;
}

export function scriptedNodeTransport(steps: readonly ScriptedStep[] = []): ScriptedNodeTransport {
  const queue = [...steps];
  const requests: RecordedRequest[] = [];
  const built: NodeTransportOptions[] = [];
  const mismatches: string[] = [];
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
  let closed = 0;

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      if (requests.length >= waiter.count) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };

  const factory = (options: NodeTransportOptions): NodeTransport => {
    built.push(options);
    return {
      async request(request: NodeRequest): Promise<NodeResponse> {
        if (request.signal.aborted) throw abortFailure(request.signal);
        const path = new URL(request.url).pathname;
        const seen: RecordedRequest = {
          method: request.method,
          url: request.url,
          path,
          headers: { ...options.headers, ...request.headers },
          ...(request.body === undefined ? {} : { body: request.body }),
        };
        requests.push(seen);
        notify();
        const step = queue[0];
        if (step === undefined || step.method !== request.method || step.path !== path) {
          const expected = step === undefined ? "nothing" : `${step.method} ${step.path}`;
          mismatches.push(`expected ${expected}, got ${request.method} ${path}`);
          throw new Error(`Unexpected request ${request.method} ${path}`);
        }
        queue.shift();
        const reply = typeof step.reply === "function" ? step.reply(seen) : step.reply;
        if ("hang" in reply) {
          return new Promise<NodeResponse>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(abortFailure(request.signal)), { once: true });
          });
        }
        if ("fail" in reply) throw new TransportError(reply.fail, `scripted ${reply.fail}`, reply);
        if ("throws" in reply) throw reply.throws;
        const text = bodyText(reply.body);
        if (Buffer.byteLength(text) > request.maxResponseBytes) {
          throw new TransportError("too-large", "The response exceeded the limit for one response");
        }
        return {
          status: reply.status,
          contentType: reply.contentType === undefined ? "application/json" : reply.contentType,
          retryAfter: reply.retryAfter ?? null,
          text,
        };
      },
      close() {
        closed += 1;
      },
    };
  };

  return {
    factory,
    requests,
    built,
    mismatches,
    closes: () => closed,
    left: () => queue.length,
    push: (...more) => queue.push(...more),
    received: (count) =>
      new Promise<void>((resolve) => {
        waiters.push({ count, resolve });
        notify();
      }),
    expectDone() {
      if (mismatches.length > 0) throw new Error(`Unexpected requests: ${mismatches.join("; ")}`);
      if (queue.length > 0) {
        throw new Error(`Steps not taken: ${queue.map((step) => `${step.method} ${step.path}`).join("; ")}`);
      }
    },
  };
}

/** The n-th UUID `newId` gives, from 1. */
export function testUuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The query id of a POST whose `newId` draw was the n-th: its UUID's 32 hex digits. */
export function testQueryId(n: number): string {
  return testUuid(n).replaceAll("-", "");
}

export interface TestDeadline {
  readonly ms: number;
  readonly signal: AbortSignal;
}

export interface TransportTestDeps {
  readonly deps: DatabendHttpTransportDeps;
  /** Every deadline asked for, in order. */
  readonly deadlines: TestDeadline[];
  /** Every sleep asked for, in ms. */
  readonly sleeps: number[];
  now(): number;
  advance(ms: number): void;
  /** Fires every pending deadline of `ms`, as `AbortSignal.timeout()` fires. */
  fire(ms: number): void;
  /** Runs `hook` at the start of every later sleep, such as firing a deadline while a resend waits. */
  onSleep(hook: (ms: number) => void): void;
}

export const TEST_START = Date.UTC(2026, 9, 8, 2, 0, 0);

export function transportDeps(
  script: ScriptedNodeTransport,
  overrides: { readonly latch?: AuthLatch; readonly random?: number } = {},
): TransportTestDeps {
  let now = TEST_START;
  let ids = 0;
  const deadlines: Array<TestDeadline & { readonly controller: AbortController }> = [];
  const sleeps: number[] = [];
  const clock = () => now;
  let sleeping: (ms: number) => void = () => {};
  return {
    deps: {
      createNodeTransport: script.factory,
      latch: overrides.latch ?? createAuthLatch({ now: clock }),
      sleep: async (ms) => {
        sleeping(ms);
        sleeps.push(ms);
        now += ms;
      },
      random: () => overrides.random ?? 0.5,
      now: clock,
      newId: () => testUuid(++ids),
      deadline: (ms) => {
        const controller = new AbortController();
        deadlines.push({ ms, signal: controller.signal, controller });
        return controller.signal;
      },
    },
    deadlines,
    sleeps,
    now: clock,
    advance: (ms) => {
      now += ms;
    },
    onSleep: (hook) => {
      sleeping = hook;
    },
    fire: (ms) => {
      for (const deadline of deadlines) {
        if (deadline.ms === ms && !deadline.signal.aborted) {
          deadline.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
        }
      }
    },
  };
}

/** A signal that a test aborts as the user's cancel, or as the statement deadline the provider folds in. */
export function runSignal(): { readonly signal: AbortSignal; cancel(): void; expire(): void } {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel: () => controller.abort(),
    expire: () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
  };
}

/** The node id the answers below carry, in the shape the transport accepts. */
export const TEST_NODE = "node_1-a";

/** One 200 answer of the query API, every field a test leaves out at a plain, finished, single-page value. */
export function answerBody(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "",
    session_id: "",
    node_id: TEST_NODE,
    state: "Succeeded",
    session: {
      catalog: "default",
      database: "default",
      role: "account_admin",
      settings: { http_json_result_mode: "display" },
      txn_state: "AutoCommit",
      need_sticky: false,
      need_keep_alive: false,
    },
    error: null,
    warnings: [],
    has_result_set: true,
    schema: [],
    data: [],
    affect: null,
    next_uri: null,
    ...fields,
  };
}

/**
 * The `response` of exchange `index` of a committed capture, its placeholders (`<query-2>`, `<session-5>`,
 * `<node-1>`) replaced by `values`, as a scripted reply.
 */
export function capturedAnswer(
  scenario: string,
  index: number,
  values: Readonly<Record<string, string>>,
): ScriptedReply & { readonly status: number; readonly body: string } {
  const capture = JSON.parse(readFileSync(join(CAPTURES, `${scenario}.json`), "utf8")) as {
    exchanges: Array<{ response: { status: number; headers: Record<string, string>; body: unknown } }>;
  };
  const { response } = capture.exchanges[index];
  let text = JSON.stringify(response.body);
  for (const [placeholder, value] of Object.entries(values)) text = text.replaceAll(placeholder, value);
  return { status: response.status, body: text, contentType: response.headers["content-type"] ?? null };
}

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
export const TEST_USER = "reader";
export const TEST_PASSWORD = "stand-in-1";
export const TEST_VERSION = "1.2.3";

/** A Databend connection on loopback, where a password may travel without TLS, with `overrides` on top. */
export function testConnection(overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "c1",
    name: "Databend",
    type: "databend",
    host: "127.0.0.1",
    port: 8000,
    user: TEST_USER,
    password: TEST_PASSWORD,
    createdAt: new Date(0),
    ...overrides,
  } as unknown as DatabaseConnection;
}

/**
 * The validated options of `testConnection(overrides)`, through an SSH tunnel when `tunnel` is given: its far end under
 * `TUNNEL_FAR_END` and its route under `TUNNEL_ROUTE`, as Studio's provider factory hands a tunnelled provider both.
 */
export function testOptions(
  overrides: Record<string, unknown> = {},
  {
    queryTimeout = 60_000,
    tunnel,
  }: {
    readonly queryTimeout?: number;
    readonly tunnel?: { readonly farEnd: TunnelFarEnd; readonly route: string };
  } = {},
): DatabendConnectionOptions {
  const connection = testConnection(overrides);
  return buildDatabendConnectionOptions(
    tunnel === undefined
      ? connection
      : Object.assign(connection, { [TUNNEL_FAR_END]: tunnel.farEnd, [TUNNEL_ROUTE]: tunnel.route }),
    { queryTimeout, appVersion: TEST_VERSION, egress: ALLOWS_PRIVATE_HOSTS },
  );
}

export interface TransportHarness {
  readonly script: ScriptedNodeTransport;
  readonly time: TransportTestDeps;
  readonly options: DatabendConnectionOptions;
  readonly transport: DatabendTransport;
}

/** A transport over a scripted node transport and injected time. */
export function transportHarness(
  steps: readonly ScriptedStep[],
  {
    options = testOptions(),
    latch,
    random,
  }: { readonly options?: DatabendConnectionOptions; readonly latch?: AuthLatch; readonly random?: number } = {},
): TransportHarness {
  const script = scriptedNodeTransport(steps);
  const time = transportDeps(script, { latch, random });
  return { script, time, options, transport: createDatabendHttpTransport(options, time.deps) };
}

/** One statement request, with a signal that never fires unless one is given. */
export function statement(
  sql: string,
  {
    origin = "user",
    rowCut = 1000,
    signal = new AbortController().signal,
  }: { readonly origin?: StatementOrigin; readonly rowCut?: number; readonly signal?: AbortSignal } = {},
): StatementRequest {
  return { sql, origin, rowCut, signal };
}

/** The ids of the n-th statement a harness runs, from 1, when no ROLLBACK drew an id in between. */
export function idsOf(n: number): { readonly queryId: string; readonly sessionId: string; readonly routeHint: string } {
  const base = (n - 1) * 3;
  return { queryId: testQueryId(base + 1), sessionId: testUuid(base + 2), routeHint: testUuid(base + 3) };
}

/** A 200 answer of statement `ids`, with `fields` on top. */
export function ok(
  ids: { readonly queryId: string; readonly sessionId: string },
  fields: Record<string, unknown> = {},
): ScriptedReply {
  return { status: 200, body: answerBody({ id: ids.queryId, session_id: ids.sessionId, ...fields }) };
}

/** The paths of statement `queryId`. */
export function pathsOf(queryId: string) {
  return {
    page: (n: number) => `/v1/query/${queryId}/page/${n}`,
    final: `/v1/query/${queryId}/final`,
    kill: `/v1/query/${queryId}/kill`,
  };
}

/**
 * The ids a request on the wire carries: the query id header a POST sends, and the session id inside its
 * `x-databend-session`, so a local server can answer as Databend answers our own statement.
 */
export function wireIds(headers: Readonly<Record<string, string | string[] | undefined>>): {
  readonly queryId: string;
  readonly sessionId: string;
} {
  const session = JSON.parse(Buffer.from(String(headers["x-databend-session"]), "base64url").toString("utf8")) as {
    id: string;
  };
  return { queryId: String(headers["x-databend-query-id"] ?? ""), sessionId: session.id };
}
