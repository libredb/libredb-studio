import { QueryCancelledError, TimeoutError } from "@/lib/db/errors";
import type { ProviderLimiter, RunRegistry } from "@/lib/db/utils/bounded-limiter";
import type { QueryResult } from "@/lib/types";
import type { QdrantAnswer, QdrantOp, QdrantSend } from "./client";
import {
  parseQdrantRequest,
  type QdrantCollectionFacts,
  qdrantPhase0,
  qdrantPhase1,
  qdrantVersionGates,
} from "./request";
import { qdrantResult } from "./results";
import { QDRANT_BOUNDS } from "./routes";

/**
 * Runs one console request: phase 0 and the version gates with no call, then one limiter permit held for the
 * whole request, one `GET /collections/{collection_name}` per collection phase 1 needs, phase 1, and the one
 * execution call, strictly one after another, so the request never has two calls in flight.
 *
 * One deadline, fixed when the request arrives and before the queue: 10 s for a metadata route and 30 s for a
 * point read or query, at most the connection's query timeout. The queue wait, the collection reads and the
 * execution call share it, and the execution call of a route that declares `timeout` carries
 * `max(1, floor(D) - 1)` whole seconds, D being what is left of the deadline when the request is written; a
 * user's own `timeout` is clamped to that. A run registered under its `queryId` can be cancelled; nothing is
 * retried.
 */

/** What failed, for errors.ts to word: a non-2xx answer, or what the transport threw. */
export type QdrantFailure =
  | { readonly kind: "answer"; readonly op: QdrantOp; readonly answer: QdrantAnswer }
  | { readonly kind: "thrown"; readonly op: QdrantOp; readonly error: unknown; readonly body?: string };

export interface QdrantExecution {
  /** The client's send, narrowed to the console's operations. */
  readonly send: QdrantSend<QdrantOp>;
  readonly limiter: ProviderLimiter;
  readonly runs: RunRegistry;
  /** The version `GET /` reported at connect, or null where it reported none. */
  readonly version: string | null;
  /** A `GET /collections/{collection_name}` answer's text as the facts phase 1 and the result read (schema.ts). */
  readonly factsOf: (text: string) => QdrantCollectionFacts;
  /** The Studio error for a failure (errors.ts). */
  readonly fail: (failure: QdrantFailure) => Error;
  /** The connection's query timeout in ms, which bounds every deadline; absent where none is set. */
  readonly queryTimeoutMs?: number;
  /** The clock; only a test passes another. */
  readonly now?: () => number;
  /** The deadline's signal; only a test passes another. */
  readonly deadline?: (ms: number) => AbortSignal;
}

const METADATA_OPS: ReadonlySet<QdrantOp> = new Set([
  "root",
  "get_collections",
  "get_collection",
  "collection_exists",
  "get_collections_aliases",
  "get_collection_aliases",
  "get_optimizations",
  "list_snapshots",
  "collection_cluster_info",
]);

const ok = (answer: QdrantAnswer): boolean => answer.status >= 200 && answer.status < 300;

/** The deadline, in ms, of a request to `op`: a metadata route's or a point read's, at most the query timeout. */
export function qdrantDeadlineMs(op: QdrantOp, queryTimeoutMs: number | undefined): number {
  const own = METADATA_OPS.has(op) ? QDRANT_BOUNDS.metadataDeadlineMs : QDRANT_BOUNDS.pointReadDeadlineMs;
  return queryTimeoutMs === undefined || queryTimeoutMs <= 0 ? own : Math.min(own, queryTimeoutMs);
}

/** The `timeout` a request written with `remainingMs` left carries: whole seconds, at least 1, a second short. */
export function qdrantServerTimeout(remainingMs: number): number {
  return Math.max(1, Math.floor(remainingMs / 1000) - 1);
}

export async function executeQdrant(
  text: string,
  queryId: string | undefined,
  run: QdrantExecution,
): Promise<QueryResult> {
  const now = run.now ?? Date.now;
  const startedAt = now();
  const plan = qdrantPhase0(parseQdrantRequest(text));
  qdrantVersionGates(plan, run.version);
  const deadlineMs = qdrantDeadlineMs(plan.route.op, run.queryTimeoutMs);
  const deadline = (run.deadline ?? ((ms: number) => AbortSignal.timeout(ms)))(deadlineMs);
  const handle = run.runs.begin(queryId, deadline);
  const stopped = (): Error => {
    const reason: unknown = handle.signal.reason;
    if (reason instanceof QueryCancelledError) return reason;
    return new TimeoutError(`The request did not finish within its ${deadlineMs / 1000} s deadline.`);
  };
  const call = async (request: Parameters<QdrantExecution["send"]>[0]): Promise<QdrantAnswer> => {
    let answer: QdrantAnswer;
    try {
      answer = await run.send(request, handle.signal);
    } catch (error) {
      if (handle.signal.aborted) throw stopped();
      throw run.fail({
        kind: "thrown",
        op: request.op,
        error,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    }
    if (!ok(answer)) throw run.fail({ kind: "answer", op: request.op, answer });
    return answer;
  };
  try {
    let ticket: Awaited<ReturnType<ProviderLimiter["acquire"]>>;
    try {
      ticket = await run.limiter.acquire(handle.signal);
    } catch (error) {
      if (handle.signal.aborted) throw stopped();
      throw error;
    }
    try {
      const facts = new Map<string, QdrantCollectionFacts>();
      for (const collection of plan.collections) {
        // oxlint-disable-next-line no-await-in-loop -- a request holds one permit, so its reads go one after another.
        const answer = await call({ op: "get_collection", params: { collection_name: collection }, query: {} });
        facts.set(collection, run.factsOf(answer.text));
      }
      const wire = qdrantPhase1(plan, facts);
      const query = { ...wire.query };
      if (Object.hasOwn(plan.route.query, "timeout")) {
        const ceiling = qdrantServerTimeout(startedAt + deadlineMs - now());
        const asked = query.timeout === undefined ? ceiling : Math.min(Number(query.timeout), ceiling);
        query.timeout = String(asked);
      }
      const answer = await call({
        op: wire.op,
        params: wire.params,
        query,
        ...(wire.body === undefined ? {} : { body: wire.body }),
      });
      return qdrantResult(answer.text, wire.shape, { executionTime: now() - startedAt });
    } finally {
      ticket.release();
    }
  } finally {
    handle.end();
  }
}
