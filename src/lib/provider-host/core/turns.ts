/**
 * A turn of the event loop before every pull (docs/providers/CONTRACT.md, clause C-49), part of the provider host core.
 *
 * A source over rows already in memory answers each pull from the microtask queue, so a page pumped from it never
 * yields: the server's other requests, its timers and its I/O wait until the whole page is measured. `withTurns` wraps a
 * result source so each `next` first awaits one `setImmediate` turn from `node:timers/promises`, then refuses the pull,
 * as `checkCallStart` answers, when the call's signal aborted or its deadline passed during that turn, and only then
 * pulls. The pump's own check runs before the turn, so the second check covers what the turn let happen. The longest a
 * page then holds the event loop is one batch's pull and measure, which the host page benchmark holds under T4.
 *
 * The turn is the host's policy and lives here, not in the SDK's `pumpPage`: the pump is also the kit's, and runs where
 * fake timers may hold `setImmediate`. `columns`, `rowCount` and `close` are the source's own.
 *
 * Core imports only the SDK's public subpaths other than `testing`, Node built-ins and its own files, and keeps no
 * module state (tests/unit/lib/provider-host/core-boundary.test.ts).
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  type BatchLimit,
  type CallContext,
  CallRefusalError,
  checkCallStart,
  type ResultSource,
  type RowBatch,
} from "@libredb/provider-sdk/calls";

/**
 * `source`, each pull preceded by one turn of the event loop and refused when the call `ctx` ended during it.
 *
 * Each `next` throws `CallRefusalError` with every refusal `checkCallStart` answers after the turn, the signal's reason
 * as its cause when the signal aborted, and the source is not pulled.
 */
export function withTurns(source: ResultSource, ctx: Pick<CallContext, "deadline" | "signal">): ResultSource {
  return Object.freeze({
    columns: source.columns,
    ...(source.rowCount === undefined ? {} : { rowCount: source.rowCount }),
    async next(limit: BatchLimit): Promise<RowBatch> {
      await nextTurn();
      const refusals = checkCallStart(ctx);
      if (refusals.length > 0) {
        throw new CallRefusalError(refusals, ctx.signal.aborted ? { cause: ctx.signal.reason } : undefined);
      }
      return source.next(limit);
    },
    close: () => source.close(),
  });
}
