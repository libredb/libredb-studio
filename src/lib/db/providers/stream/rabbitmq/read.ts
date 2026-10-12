/**
 * `query()`: one stream read, from the editor text to the nine-column result.
 *
 * 1. The empty-text and bound-params refusals, then the deadline D = min(queryTimeout, RABBITMQ_READ_DEADLINE_MS) is
 *    fixed and the run registered under `AbortSignal.any([D, the provider's lifetime])`, so a Stop, D and
 *    `disconnect()` all reach every later step through one signal.
 * 2. The request is validated before any I/O; a connection without AMQP port refuses here.
 * 3. The type check: one management GET under one management permit, released before the next step, under the run's
 *    signal, so a Stop, D and `disconnect()` during it end with the same sentences as in the queue; anything but a
 *    stream refuses, because a consume on a queue would remove its messages.
 * 4. The read limiter, one read per provider instance and four per process, waited for under D.
 * 5. and 6. The AMQP read, which owns its socket and timers and leaves neither behind.
 * 7. The result.
 *
 * The two permits are never held at once, and every failure on the way ends in the one boundary of errors.ts, so no
 * value this module did not build reaches the caller.
 */
import { QueryCancelledError } from "@/lib/db/errors";
import {
  engineLimiter,
  LimiterFullError,
  type LimiterTicket,
  type ProviderLimiter,
  type RunHandle,
  type RunRegistry,
} from "@/lib/db/utils/bounded-limiter";
import type { QueryResult } from "@/lib/types";
import type { AmqpDial } from "./amqp/dial";
import { readStream, type StreamReadOutcome } from "./amqp/read-loop";
import type { RabbitMQEndpoints } from "./connection-options";
import {
  AMQP_PORT_REQUIRED,
  cancelledError,
  configError,
  isOwnError,
  type ManagementFailureContext,
  managementTimeout,
  notAStream,
  queryError,
  rabbitmqBoundary,
  READ_CANCELLED_BEFORE_START,
  READ_SLOTS_FULL,
  readPhaseTimeout,
  REQUEST_EMPTY,
  REQUEST_PARAMS,
} from "./errors";
import {
  type DeadlineSignalFactory,
  type RabbitMQClock,
  RABBITMQ_READ_DEADLINE_MS,
  RABBITMQ_READ_LIMITER_KEY,
  RABBITMQ_READ_LIMITS,
} from "./limits";
import type { ManagementClient, StreamTypeAnswer } from "./management/client";
import { MANAGEMENT_ROUTES } from "./management/routes";
import { parseReadRequest, type ReadRequest } from "./request";
import { buildReadResult } from "./results";

/** One limiter table for the process; each provider instance calls this once for its own slot. */
export const rabbitmqReadLimiter: () => ProviderLimiter = engineLimiter(
  RABBITMQ_READ_LIMITER_KEY,
  RABBITMQ_READ_LIMITS,
);

/** The `{route}` a read's unexpected failure names: a fixed label, never a URL or a name. */
const STREAM_READ_ROUTE = "the stream read";

export interface ReadDependencies {
  readonly endpoints: RabbitMQEndpoints;
  readonly management: ManagementClient;
  readonly readLimiter: ProviderLimiter;
  readonly runs: RunRegistry;
  readonly lifetime: AbortSignal;
  readonly queryTimeoutMs: number;
  readonly dial: AmqpDial;
  readonly clock: RabbitMQClock;
  readonly deadlineSignal: DeadlineSignalFactory;
  readonly onSkippedBytes?: (view: Uint8Array) => void;
  readonly studioVersion: string | null;
}

export async function runRead(
  text: string,
  params: unknown[] | undefined,
  queryId: string | undefined,
  deps: ReadDependencies,
): Promise<QueryResult> {
  const endpoint = deps.endpoints.amqp?.display ?? deps.endpoints.management.display;
  try {
    return await read(text, params, queryId, deps);
  } catch (error) {
    throw rabbitmqBoundary(error, { site: "read", endpoint, route: STREAM_READ_ROUTE });
  }
}

async function read(
  text: string,
  params: unknown[] | undefined,
  queryId: string | undefined,
  deps: ReadDependencies,
): Promise<QueryResult> {
  // After disconnect() the lifetime's reason is the provider's own closed sentence, and nothing is sent.
  if (deps.lifetime.aborted) throw deps.lifetime.reason;
  if (text.trim() === "") throw queryError(REQUEST_EMPTY);
  if (params !== undefined && params.length > 0) throw configError(REQUEST_PARAMS);
  const startedAt = deps.clock.now();
  const deadlineMs = Math.min(deps.queryTimeoutMs, RABBITMQ_READ_DEADLINE_MS);
  const run = beginRun(deps.runs, queryId, AbortSignal.any([deps.deadlineSignal(deadlineMs), deps.lifetime]));
  try {
    const request = parseReadRequest(text);
    const amqp = deps.endpoints.amqp;
    if (amqp === null) throw configError(AMQP_PORT_REQUIRED);
    const seconds = deadlineMs / 1000;
    const checked = await checkStreamType(deps, request, run.signal, seconds);
    if (checked.type !== "stream") throw notAStream(request.stream, checked.type);
    const ticket = await acquireReadSlot(deps.readLimiter, run.signal, {
      seconds,
      endpoint: amqp.display,
      stream: request.stream,
    });
    let outcome: StreamReadOutcome;
    try {
      outcome = await readStream({
        endpoint: amqp,
        vhost: request.vhost,
        stream: request.stream,
        from: request.from,
        limit: request.limit,
        signal: run.signal,
        deadlineSeconds: seconds,
        replicas: { online: checked.online, members: checked.members },
        dial: deps.dial,
        clock: deps.clock,
        studioVersion: deps.studioVersion,
        ...(deps.onSkippedBytes === undefined ? {} : { onSkippedBytes: deps.onSkippedBytes }),
      });
    } finally {
      ticket.release();
    }
    return buildReadResult(outcome, request, deps.clock.now() - startedAt, seconds);
  } finally {
    run.end();
  }
}

/** The registry's refusals (a malformed or repeated queryId) are Studio's own sentences, carried as own errors. */
function beginRun(runs: RunRegistry, queryId: string | undefined, signal: AbortSignal): RunHandle {
  try {
    return runs.begin(queryId, signal);
  } catch (error) {
    throw queryError((error as Error).message);
  }
}

/** A Stop or `disconnect()` that ended a wait: the provider's own closed sentence, or the stop-before-start one. */
function cancelReason(signal: AbortSignal): QueryCancelledError | undefined {
  const reason: unknown = signal.reason;
  if (!(reason instanceof QueryCancelledError)) return undefined;
  return isOwnError(reason) ? reason : cancelledError(READ_CANCELLED_BEFORE_START);
}

/**
 * The type check under the run's signal. The client rejects with the signal's reason as given, so the reason is read
 * here: a Stop or `disconnect()` as in the queue, D as the management timeout of the type check, since no AMQP byte
 * was sent; a failure while the signal is live is the client's own error.
 */
async function checkStreamType(
  deps: ReadDependencies,
  request: ReadRequest,
  signal: AbortSignal,
  seconds: number,
): Promise<StreamTypeAnswer> {
  const parts = { vhost: request.vhost, name: request.stream };
  try {
    return await deps.management.get("stream-type", parts, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
    const cancelled = cancelReason(signal);
    if (cancelled !== undefined) throw cancelled;
    const context: ManagementFailureContext = {
      endpoint: deps.endpoints.management.display,
      route: MANAGEMENT_ROUTES["stream-type"].label,
      scope: "object",
      site: "read",
      ...parts,
    };
    throw managementTimeout(context, seconds);
  }
}

/**
 * A full queue refuses at once; a wait that ends by the run's signal says why: the provider closing, a Stop, or D,
 * which names the queue as the phase, because the type check's GET was already sent and no AMQP byte was.
 */
async function acquireReadSlot(
  limiter: ProviderLimiter,
  signal: AbortSignal,
  context: { readonly seconds: number; readonly endpoint: string; readonly stream: string },
): Promise<LimiterTicket> {
  try {
    return await limiter.acquire(signal);
  } catch (error) {
    if (error instanceof LimiterFullError) throw queryError(READ_SLOTS_FULL);
    const cancelled = cancelReason(signal);
    if (cancelled !== undefined) throw cancelled;
    throw readPhaseTimeout("queued", context);
  }
}
