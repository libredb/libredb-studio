/**
 * The admission gate of query execution (spec 7.8, 7.9): whether a statement may run while Studio cannot record the
 * query event it would leave.
 *
 * A route calls `admitQueryExecution()` before a statement reaches the database. With the runtime setting
 * `queryLog.onSinkFailure` at `refuse`, it throws a `SeedConnectionError` with 503 AUDIT_UNAVAILABLE while the query
 * event sink (`sink.ts`) is backing off after a failed insert, or while its queue holds at least 90% of its capacity,
 * so a governed Studio stops executing instead of running statements whose events would wait or be dropped. It reads
 * the sink's state as the heartbeat reports it, and lifts on its own: once an insert settles its whole batch the sink
 * stops backing off, and the queue drains.
 *
 * A row the governance source refused for good (SQLSTATE class 22 or 23) never trips it. The sink drops that row,
 * counts it in `rejected` and goes on without a backoff, so one malformed event cannot stop every execution.
 *
 * With `continue`, the default, with no valid value set, and with governance off, where no runtime value is read, it
 * never refuses and does not look at the sink.
 */
import { ApiErrorCode } from "@/lib/api/error-codes";
import { runtimeSetting } from "@/lib/governance/settings";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { QUERY_EVENT_QUEUE_CAPACITY, queryEventSinkState } from "./sink";

/**
 * The queue length from which `refuse` refuses: 90% of the queue's capacity (spec 7.9), so the events of executions
 * admitted before the gate closed still find room.
 */
const REFUSE_FROM_QUEUED = (QUERY_EVENT_QUEUE_CAPACITY * 9) / 10;

/** The sentence of every refusal. */
const AUDIT_UNAVAILABLE_MESSAGE = "Query execution is unavailable while this server cannot record query events";

/**
 * Returns when a statement may run. Throws 503 AUDIT_UNAVAILABLE when `queryLog.onSinkFailure` is `refuse` and the
 * query event sink is backing off or its queue is at least 90% full.
 */
export function admitQueryExecution(): void {
  if (runtimeSetting("queryLog.onSinkFailure") !== "refuse") return;
  const { backingOff, queued } = queryEventSinkState();
  if (!backingOff && queued < REFUSE_FROM_QUEUED) return;
  throw new SeedConnectionError(AUDIT_UNAVAILABLE_MESSAGE, 503, ApiErrorCode.AUDIT_UNAVAILABLE);
}
