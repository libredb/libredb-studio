/**
 * The SQL API over the shared node transports: one text-transport lane per bearer token, one byte transport for result
 * partitions, the request headers, and the retry ladder of each request kind.
 *
 * The shared text transport owns `authorization` as a connection header, so each token gets its own transport, a lane.
 * A request takes the lane of the token current when it is sent, so a run that crosses a renewal polls, reads and
 * cancels under the later token; a replaced lane closes once its in-flight requests end, since closing it would abort
 * them. This is BigQuery's lane pattern (`bigquery/transport.ts`), written again here because a provider imports no
 * other provider. Partitions go through the byte transport, whose `signer` sets the bearer read just before each
 * request.
 *
 * The ladder, since `retry=true` and the `requestId` match are a submit mechanism: a submit POST answered 429, 500,
 * 502, 503 or 504 is resent with the same `requestId` and `retry=true`, never without it; a status GET returns 202 and
 * 429 to the poll loop at once and resends 500, 502, 503 and 504; a partition GET resends 429, 500, 502, 503 and 504;
 * a cancel is sent once. Every resend waits a jittered backoff first, and past `SNOWFLAKE_RETRY_ATTEMPTS` sends the
 * last answer is returned for the caller to map. A `TransportError` is never retried and propagates as it is; an abort
 * during a backoff rejects with the signal's reason.
 *
 * Callers pass the statement paths; every URL is built on the one origin with `endpointUrl`, so nothing is sent to
 * another host.
 */
import { randomUUID } from "node:crypto";
import { endpointUrl, type HttpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeByteTransport,
  createNodeTransport,
  type NodeByteTransport,
  type NodeByteTransportOptions,
  type NodeTlsMaterial,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import { getAppVersion } from "@/lib/app-version";
import type { EgressDecision } from "@/lib/db/types";
import type { SnowflakeTokenSource } from "./auth";

export const SNOWFLAKE_RETRY_BASE_MS = 500;
export const SNOWFLAKE_RETRY_MAX_MS = 8_000;
/** Sends of one request, the first included. */
export const SNOWFLAKE_RETRY_ATTEMPTS = 5;
/** The largest submit or cancel answer read: either carries a handle or a status only. */
export const SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES = 1_048_576;

const appVersion = getAppVersion();
/** `LibreDB-Studio/<version>`, or the bare name in the library build, which injects no version. */
export const SNOWFLAKE_USER_AGENT = appVersion === null ? "LibreDB-Studio" : `LibreDB-Studio/${appVersion}`;

const CLOSED = "The Snowflake connection is closed";
const SUBMIT_RETRIED: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const STATUS_RETRIED: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const PARTITION_RETRIED: ReadonlySet<number> = SUBMIT_RETRIED;

/** What the transport takes from outside, each with a production value in `snowflakeProductionDeps`. */
export interface SnowflakeTransportDeps {
  readonly createNodeTransport: (options: NodeTransportOptions) => NodeTransport;
  readonly createNodeByteTransport: (options: NodeByteTransportOptions) => NodeByteTransport;
  /** The clock, in ms since the epoch. */
  readonly now: () => number;
  /** Waits `ms`; rejects with the signal's reason when it aborts first, or had aborted. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A value in [0, 1), for the backoff's jitter. */
  readonly random: () => number;
  /** A new UUID v4. */
  readonly newId: () => string;
  /** A signal that fires after `ms` with a `TimeoutError` reason, as `AbortSignal.timeout()` does. */
  readonly deadline: (ms: number) => AbortSignal;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** The production deps: the shared transports, Date.now, a signal-aware setTimeout sleep, Math.random, randomUUID and AbortSignal.timeout. */
export function snowflakeProductionDeps(): SnowflakeTransportDeps {
  return {
    createNodeTransport,
    createNodeByteTransport,
    now: Date.now,
    sleep,
    random: Math.random,
    newId: () => randomUUID(),
    deadline: (ms) => AbortSignal.timeout(ms),
  };
}

/** The wait before send `k + 1`: the base doubled `k - 1` times, capped, then jittered to between half and all of it. */
export function snowflakeBackoffMs(k: number, random: number): number {
  return Math.round(Math.min(SNOWFLAKE_RETRY_MAX_MS, SNOWFLAKE_RETRY_BASE_MS * 2 ** (k - 1)) * (0.5 + random / 2));
}

export interface SnowflakeTransportOptions {
  readonly origin: HttpOrigin;
  /** `{ rejectUnauthorized: true, identity: host }` from the provider; null only for a test's loopback origin. */
  readonly tls: NodeTlsMaterial | null;
  readonly tokens: SnowflakeTokenSource;
  /** The egress decision the provider was built with, which both transports are built with. */
  readonly egress: EgressDecision;
}

export interface SnowflakeTextAnswer {
  readonly status: number;
  readonly text: string;
  /** Sends made, the first included. */
  readonly attempts: number;
}

export interface SnowflakeByteAnswer {
  readonly status: number;
  readonly bytes: Buffer;
  /** As the server sent it, undecoded; null when absent. */
  readonly contentEncoding: string | null;
  /** True when `truncateAt` cut the body. */
  readonly truncated: boolean;
  readonly attempts: number;
}

export interface SnowflakeTransport {
  submit(path: string, body: string, signal: AbortSignal, maxResponseBytes: number): Promise<SnowflakeTextAnswer>;
  status(path: string, signal: AbortSignal, maxResponseBytes: number): Promise<SnowflakeTextAnswer>;
  partition(
    path: string,
    query: string,
    signal: AbortSignal,
    maxResponseBytes: number,
    truncateAt: number,
  ): Promise<SnowflakeByteAnswer>;
  cancel(path: string, signal: AbortSignal, maxResponseBytes: number): Promise<SnowflakeTextAnswer>;
  /** The current token and the one before it, for the secret forms of a failure's text. */
  recentTokens(): readonly string[];
  close(): void;
}

export function createSnowflakeTransport(
  options: SnowflakeTransportOptions,
  deps: SnowflakeTransportDeps,
): SnowflakeTransport {
  const { origin, tls, tokens, egress } = options;
  const headers = {
    "x-snowflake-authorization-token-type": tokens.tokenType,
    accept: "application/json",
    "user-agent": SNOWFLAKE_USER_AGENT,
  };

  type Lane = { readonly token: string; readonly node: NodeTransport; inFlight: number };
  const lanes = new Set<Lane>();
  let current: Lane | null = null;
  let closed = false;
  const recent: string[] = [];
  let bearer = "";

  const byte = deps.createNodeByteTransport({
    origin,
    tls,
    maxSockets: 4,
    egress,
    headers,
    signer: { headerNames: ["authorization"], sign: () => ({ authorization: `Bearer ${bearer}` }) },
  });

  const closedError = (): TransportError => new TransportError("aborted", CLOSED);

  /** Keeps the last two tokens seen, oldest first. */
  const note = (token: string): void => {
    if (recent.at(-1) === token) return;
    recent.push(token);
    if (recent.length > 2) recent.shift();
  };

  /** The current token, checked against `close()` on both sides of the wait. */
  async function currentToken(): Promise<string> {
    if (closed) throw closedError();
    const token = await tokens.token();
    if (closed) throw closedError();
    note(token);
    return token;
  }

  const retire = (lane: Lane): void => {
    if (lane !== current && lane.inFlight === 0) {
      lane.node.close();
      lanes.delete(lane);
    }
  };

  async function lane(): Promise<Lane> {
    const token = await currentToken();
    if (current?.token !== token) {
      const previous = current;
      current = {
        token,
        node: deps.createNodeTransport({
          origin,
          tls,
          maxSockets: 8,
          egress,
          headers: { authorization: `Bearer ${token}`, ...headers },
          refusesLinkLocal: true,
          refusesUpgrade: true,
          reportsUnreachable: true,
        }),
        inFlight: 0,
      };
      lanes.add(current);
      if (previous !== null) retire(previous);
    }
    return current;
  }

  async function send(
    method: "GET" | "POST",
    path: string,
    query: string,
    body: string | undefined,
    signal: AbortSignal,
    maxResponseBytes: number,
  ): Promise<{ readonly status: number; readonly text: string }> {
    const held = await lane();
    held.inFlight += 1;
    try {
      const url = endpointUrl(origin, path, query === "" ? undefined : new URLSearchParams(query));
      const response = await held.node.request({
        method,
        url,
        ...(body === undefined ? {} : { body }),
        signal,
        maxResponseBytes,
      });
      return { status: response.status, text: response.text };
    } finally {
      held.inFlight -= 1;
      retire(held);
    }
  }

  /** Sends up to `SNOWFLAKE_RETRY_ATTEMPTS` times while `retried` holds the status, waiting a backoff before each resend. */
  async function ladder<T extends { readonly status: number }>(
    retried: ReadonlySet<number>,
    signal: AbortSignal,
    attempt: (sends: number) => Promise<T>,
  ): Promise<T & { readonly attempts: number }> {
    let sends = 1;
    let answer = await attempt(sends);
    while (retried.has(answer.status) && sends < SNOWFLAKE_RETRY_ATTEMPTS) {
      // oxlint-disable-next-line no-await-in-loop -- the backoff must end before the resend.
      await deps.sleep(snowflakeBackoffMs(sends, deps.random()), signal);
      sends += 1;
      // oxlint-disable-next-line no-await-in-loop -- each answer decides whether there is another send.
      answer = await attempt(sends);
    }
    return { ...answer, attempts: sends };
  }

  return {
    submit(path, body, signal, maxResponseBytes) {
      const query = `async=true&requestId=${deps.newId()}`;
      return ladder(SUBMIT_RETRIED, signal, (sends) =>
        send("POST", path, sends === 1 ? query : `${query}&retry=true`, body, signal, maxResponseBytes),
      );
    },

    status(path, signal, maxResponseBytes) {
      return ladder(STATUS_RETRIED, signal, () => send("GET", path, "", undefined, signal, maxResponseBytes));
    },

    partition(path, query, signal, maxResponseBytes, truncateAt) {
      return ladder(PARTITION_RETRIED, signal, async () => {
        bearer = await currentToken();
        const response = await byte.request({
          method: "GET",
          target: { path, query },
          signal,
          maxResponseBytes,
          truncateAt,
        });
        return {
          status: response.status,
          bytes: response.bytes,
          contentEncoding: response.contentEncoding,
          truncated: response.truncated,
        };
      });
    },

    async cancel(path, signal, maxResponseBytes) {
      return { ...(await send("POST", path, "", undefined, signal, maxResponseBytes)), attempts: 1 };
    },

    recentTokens: () => [...recent],

    close() {
      closed = true;
      current = null;
      for (const held of lanes) held.node.close();
      lanes.clear();
      byte.close();
    },
  };
}
