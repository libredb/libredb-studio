/**
 * The bounded watch of spec 5.3, through the one method of the seam it calls.
 *
 * One watch runs for its window, which execute.ts decides (the typed --command-timeout, else
 * etcdctl's 5 seconds, capped by the query timeout less the watch margin), and ends early at the
 * row limit or at the byte budget of spec 5.4. The window is closed by the injected clock, never by
 * the call's deadline, which stays the query timeout (spec 5.3): the window's timer aborts this
 * loop's own signal, and a batch that arrives once the window has run out is not held, so a timer
 * that fires late adds no event.
 *
 * How the watch ended is always said. A closed window, the row limit and the byte budget are the
 * outcome, which results.ts words as its one warning; a compaction, a cancellation etcd sent in
 * band, a stream that failed and the caller's own cancel or deadline are errors, never a quiet
 * window, and the events read before them are not shown as a complete window (spec 5.3, plan Review
 * Focus 3). The adapter ends the stream with `call.cancel()` on every one of these ends (plan C1,
 * spec E16); this loop releases its timer and its listener on the caller's signal in a `finally`.
 */
import type { EtcdClient, EtcdWatchBatch, EtcdWatchEnd, EtcdWatchEvent, EtcdWatchRequest } from "./client";
import { type EtcdErrorConnection, type EtcdErrorContext, toEtcdError, toProviderError, watchEndError } from "./errors";
import type { WatchOutcome } from "./results";

/** The bytes one event holds against the byte budget: its key and value, and its previous value (spec 5.4). */
function eventBytes(event: EtcdWatchEvent): number {
  return event.kv.key.byteLength + event.kv.value.byteLength + (event.prevKv?.value.byteLength ?? 0);
}

export async function runBoundedWatch(
  client: Pick<EtcdClient, "watch">,
  request: EtcdWatchRequest,
  bounds: {
    readonly windowMs: number;
    readonly capped?: { readonly queryTimeoutMs: number };
    readonly rowLimit: number;
    readonly byteBudget: number;
    readonly rangeLabel: string;
  },
  context: {
    readonly signal: AbortSignal;
    readonly now: () => number;
    readonly setTimer: (ms: number, fn: () => void) => () => void;
    readonly errors: EtcdErrorConnection;
    /** What the user may read, when spec 4.7's walks read the grants, for a PermissionDenied cancellation (spec 5.6). */
    readonly readable?: { readonly user: string; readonly ranges: string };
  },
): Promise<WatchOutcome> {
  const failure: EtcdErrorContext = {
    command: "watch",
    write: false,
    range: bounds.rangeLabel,
    readable: context.readable,
    connection: context.errors,
  };
  const { signal } = context;
  // A watch the caller already stopped opens no stream.
  if (signal.aborted) throw toProviderError(toEtcdError(signal.reason, signal), failure);

  const events: EtcdWatchEvent[] = [];
  let bytes = 0;
  let endedBy: WatchOutcome["endedBy"] | undefined;
  const watching = new AbortController();
  const forward = () => watching.abort(signal.reason);
  signal.addEventListener("abort", forward, { once: true });
  const opened = context.now();
  const releaseWindow = context.setTimer(bounds.windowMs, () => {
    endedBy ??= "window";
    watching.abort();
  });

  const onBatch = (batch: EtcdWatchBatch): "continue" | "stop" => {
    if (context.now() - opened >= bounds.windowMs) {
      endedBy ??= "window";
      return "stop";
    }
    for (const event of batch.events) {
      if (events.length === bounds.rowLimit) {
        endedBy = "rows";
        return "stop";
      }
      const size = eventBytes(event);
      // The first event is held however large it is, so an oversized value still answers one row.
      if (events.length > 0 && bytes + size > bounds.byteBudget) {
        endedBy = "bytes";
        return "stop";
      }
      events.push(event);
      bytes += size;
    }
    if (events.length === bounds.rowLimit) {
      endedBy = "rows";
      return "stop";
    }
    if (bytes >= bounds.byteBudget) {
      endedBy = "bytes";
      return "stop";
    }
    return "continue";
  };

  let end: EtcdWatchEnd;
  try {
    end = await client.watch(request, onBatch, { signal: watching.signal });
  } catch (error) {
    throw toProviderError(error, failure);
  } finally {
    releaseWindow();
    signal.removeEventListener("abort", forward);
  }
  // A watch this loop did not end was ended by etcd or by the caller's signal, cancelQuery or the query timeout. Once
  // that signal has aborted, its abort is the end, so a refusal etcd sent in band, whose renewal the abort cut short,
  // is not raised in its place (spec 5.6); otherwise an end etcd sent is raised as an error.
  const ended = endedBy === undefined && signal.aborted ? undefined : watchEndError(end, failure);
  if (ended !== undefined) throw ended;
  if (endedBy === undefined) throw toProviderError(toEtcdError(signal.reason, signal), failure);
  return {
    events,
    endedBy,
    rangeLabel: bounds.rangeLabel,
    windowMs: bounds.windowMs,
    ...(bounds.capped === undefined ? {} : { capped: bounds.capped }),
  };
}
