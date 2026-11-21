/**
 * The global that holds this process's query event sink, and a synchronous count of the events it still queues.
 *
 * The sink (src/lib/query-events/sink.ts) keeps its queue, counters and timer in a global under this registered
 * symbol, one per process, because the routes that record events and the heartbeat that reports them run in different
 * bundles. The uncaught-exception exit (src/lib/uncaught-exception.ts) reads the count from here and not from the sink,
 * so the first boot step loads this module, which imports nothing, and not the sink's governance and storage modules.
 */

/** The registered symbol the sink's global is kept under. */
export const QUERY_EVENT_SINK_KEY = Symbol.for("libredb-studio.query-event-sink");

/** The part of the sink this module reads: its queue, the events of an insert under way included. */
type QueuedHolder = { [QUERY_EVENT_SINK_KEY]?: { readonly queue: readonly unknown[] } };

/**
 * The events the sink of this process has not seen inserted, those of an insert under way included, or 0 while it has
 * recorded none.
 */
export function queuedQueryEventCount(): number {
  return (globalThis as QueuedHolder)[QUERY_EVENT_SINK_KEY]?.queue.length ?? 0;
}
