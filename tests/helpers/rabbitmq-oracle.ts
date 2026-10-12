/**
 * The R-S1 oracle of the RabbitMQ live check: did a run of the provider take any message from a classic or quorum
 * queue? The broker answers through its own counters, so the answer does not depend on reading the provider's code.
 *
 * The per-queue family `queue_delivery_metrics` of `/metrics/detailed` counts every AMQP 0-9-1 and management take;
 * every take moves one of `queue_get_ack_total`, `queue_get_total`, `queue_messages_delivered_ack_total` or
 * `queue_messages_delivered_total`. The oracle compares the whole row of every classic and quorum queue, selected by
 * `type` from `/api/queues` and never by name, before and after the run; a row absent before must stay absent, since
 * a queue nothing has taken from has no row at all. Stream rows are not guarded: a stream read moves its own row.
 * Three things would make a comparison that cannot fail, and each is refused: a family that is missing (it answers
 * 200 with no TYPE line), `management.rates_mode = none` (the rows never move), and a scrape of the wrong vhost. The
 * first is checked before the baseline; the control take after the comparison covers the other two.
 */

export const TAKE_COUNTERS = [
  "queue_get_ack_total",
  "queue_get_total",
  "queue_messages_delivered_ack_total",
  "queue_messages_delivered_total",
] as const;

/** One vhost's rows: queue name to counter name to value. */
export type CounterRows = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** A label value as Prometheus writes it: backslash, double quote and newline escaped. */
const labelValue = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

const unescapeLabel = (value: string): string =>
  value.replace(/\\(["\\n])/g, (_m, c: string) => (c === "n" ? "\n" : c));

/**
 * Reads one `/metrics/detailed?family=queue_delivery_metrics` answer into rows for `vhost`; throws "oracle broken" when
 * any TYPE line of the take set is missing, because a family that is absent answers 200 with no TYPE line.
 */
export function parseDeliveryMetrics(text: string, vhost: string): CounterRows {
  const missing = TAKE_COUNTERS.filter((counter) => !text.includes(`# TYPE rabbitmq_detailed_${counter} counter`));
  if (missing.length > 0) {
    throw new Error(
      `The oracle is broken: /metrics/detailed has no TYPE line for ${missing.join(", ")}, so the queue_delivery_metrics family is absent.`,
    );
  }
  const rows: Record<string, Record<string, number>> = {};
  const wanted = `vhost="${labelValue(vhost)}"`;
  for (const line of text.split("\n")) {
    const match = /^rabbitmq_detailed_(\w+)\{(.*)\} (\S+)$/.exec(line);
    if (!match) continue;
    const labels = match[2];
    if (!labels.split(/,(?=\w+=")/).includes(wanted)) continue;
    const queue = /(?:^|,)queue="((?:[^"\\]|\\.)*)"/.exec(labels);
    if (!queue) continue;
    const name = unescapeLabel(queue[1]);
    rows[name] ??= {};
    rows[name][match[1]] = Number(match[3]);
  }
  return rows;
}

/** Every guarded queue whose row differs, absent rows included, as one line each; empty when the run took nothing. */
export function rowDifferences(guarded: readonly string[], before: CounterRows, after: CounterRows): string[] {
  const lines: string[] = [];
  for (const queue of guarded) {
    const was = JSON.stringify(before[queue] ?? null);
    const is = JSON.stringify(after[queue] ?? null);
    if (was !== is) lines.push(`${queue}: ${was} -> ${is}`);
  }
  return lines;
}

/** The control's verdict: the canary's `queue_get_total` moved by exactly one and nothing else in its row moved. */
export function controlMoved(before: CounterRows, after: CounterRows, canary: string): string | null {
  const was = before[canary] ?? {};
  const is = after[canary] ?? {};
  const delta = (is.queue_get_total ?? 0) - (was.queue_get_total ?? 0);
  if (delta !== 1)
    return `The control take moved queue_get_total of ${canary} by ${delta}, not 1, so the oracle cannot see a take.`;
  for (const counter of new Set([...Object.keys(was), ...Object.keys(is)])) {
    if (counter === "queue_get_total") continue;
    if ((was[counter] ?? 0) !== (is[counter] ?? 0)) return `The control take also moved ${counter} of ${canary}.`;
  }
  return null;
}

/** The broker-wide take counters for classic and quorum queues, every protocol, from `/metrics`; meaningful only on a broker the run owns. */
export function globalTakeCounters(text: string): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const match = /^(rabbitmq_global_messages_(?:delivered|get_empty)_total)\{(.*)\} (\S+)$/.exec(line);
    if (!match || !/queue_type="(?:rabbit_classic_queue|rabbit_quorum_queue)"/.test(match[2])) continue;
    out[`${match[1]}{${match[2]}}`] = Number(match[3]);
  }
  return out;
}
