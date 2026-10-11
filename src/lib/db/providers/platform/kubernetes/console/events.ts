/**
 * `kubectl events`: core events, read as JSON and walked with `continue` to the end within 5,000 events, filters
 * included, then sorted by time as kubectl events sorts them (the series' last observation, else the last timestamp,
 * else the event time) and shown newest last. The grid is kubectl's columns: LAST SEEN, TYPE, REASON, OBJECT and
 * MESSAGE, with NAMESPACE first under -A. Past 1,000 events only the newest 1,000 are shown, with a warning; a list
 * with more than 5,000 answers a sentence to narrow it, because a time order of a part would be wrong.
 *
 * `--for TYPE/NAME` selects by the involved object's kind, API version and name, as kubectl's selector does; each
 * value is escaped. A single `--types` value is also sent as a `type=` field selector, so the server narrows the set the
 * 5,000 cap counts; `--types` still filters after the read without case, as kubectl filters.
 */
import { QueryError } from "@/lib/db/errors";
import { ACCEPT_JSON } from "../client";
import { KUBERNETES_EVENTS_READ_MAX, KUBERNETES_EVENTS_SHOWN, KUBERNETES_PAGE_SIZE, KUBERNETES_TYPE } from "../limits";
import { redactResponse } from "../redaction";
import { fieldSelectorValue } from "../request-policy";
import { type KubeTable, parseTable, scanTable } from "../table";
import { ageOf, type KubectlContext, type KubectlGrid, objectOf, resolveType, stringOf, textGrid } from "./context";
import type { KubectlStatement } from "./parse";

type EventsStatement = Extract<KubectlStatement, { readonly command: "events" }>;

/** The fields of a core Event this console reads. */
export interface KubeEvent {
  readonly type?: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly count?: unknown;
  readonly eventTime?: unknown;
  readonly firstTimestamp?: unknown;
  readonly lastTimestamp?: unknown;
  readonly series?: unknown;
  readonly involvedObject?: unknown;
  readonly metadata?: unknown;
  readonly source?: unknown;
  readonly reportingComponent?: unknown;
}

export const EVENTS_CAP_SENTENCE =
  "More than 5,000 events match, and a time order of only some of them would be wrong: narrow them with --for TYPE/NAME or --types, or name a namespace with -n.";

const millis = (value: unknown): number => {
  const at = typeof value === "string" && value !== "" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
};

/** The time kubectl sorts an event by: the series' last observation, else the last timestamp, else the event time. */
export function eventTime(event: KubeEvent): number {
  const series = objectOf(event.series);
  if (series !== undefined) return millis(series.lastObservedTime);
  const last = millis(event.lastTimestamp);
  return last !== 0 ? last : millis(event.eventTime);
}

/** kubectl events' LAST SEEN: the age, and for a repeated event its count and the age of its first sighting. */
function lastSeen(context: KubectlContext, event: KubeEvent): string {
  const first =
    stringOf(event.eventTime) !== undefined && stringOf(event.eventTime) !== ""
      ? ageOf(context, event.eventTime)
      : ageOf(context, event.firstTimestamp);
  const series = objectOf(event.series);
  if (series !== undefined)
    return `${ageOf(context, series.lastObservedTime)} (x${String(series.count)} over ${first})`;
  if (typeof event.count === "number" && event.count > 1)
    return `${ageOf(context, event.lastTimestamp)} (x${event.count} over ${first})`;
  return first;
}

export async function listEvents(context: KubectlContext, statement: EventsStatement): Promise<KubectlGrid> {
  const index = await context.surface.discovery.get();
  const events = index.resources.find((entry) => entry.group === "" && entry.resource === "events");
  if (events === undefined) throw new QueryError("This server does not serve core events.", KUBERNETES_TYPE);
  const selectorParts: string[] = [];
  if (statement.forObject !== undefined) {
    const target = await resolveType(context, statement.forObject.type);
    const apiVersion = target.group === "" ? target.version : `${target.group}/${target.version}`;
    selectorParts.push(
      `involvedObject.kind=${fieldSelectorValue(target.kind)}`,
      `involvedObject.apiVersion=${fieldSelectorValue(apiVersion)}`,
      `involvedObject.name=${fieldSelectorValue(statement.forObject.name)}`,
    );
  }
  // The server matches the type with case; the parser has already written it as Normal or Warning.
  if (statement.types.length === 1) selectorParts.push(`type=${fieldSelectorValue(statement.types[0])}`);
  const fieldSelector = selectorParts.length === 0 ? undefined : selectorParts.join(",");
  const namespace = statement.allNamespaces
    ? undefined
    : (statement.namespace ?? context.surface.endpoint.defaultNamespace);
  const read = async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target: events,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          ...(fieldSelector === undefined ? {} : { fieldSelector }),
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...context.call(), accept: ACCEPT_JSON },
    );
    return parseTable(redactResponse(events, body));
  };
  const scan = await scanTable(read, { offset: 0, limit: KUBERNETES_EVENTS_READ_MAX, pageSize: KUBERNETES_PAGE_SIZE });
  if (scan.more) throw new QueryError(EVENTS_CAP_SENTENCE, KUBERNETES_TYPE);
  const typed = scan.rows
    .map((row) => (row.object ?? {}) as KubeEvent)
    // kubectl compares the type without case.
    .filter(
      (event) =>
        statement.types.length === 0 ||
        statement.types.some((type) => type.toLowerCase() === String(event.type).toLowerCase()),
    );
  // A stable sort, so events of one time keep the server's order.
  const sorted = [...typed].sort((a, b) => eventTime(a) - eventTime(b));
  const shown = sorted.slice(Math.max(0, sorted.length - KUBERNETES_EVENTS_SHOWN));
  const fields = [
    ...(statement.allNamespaces ? ["NAMESPACE"] : []),
    "LAST SEEN",
    "TYPE",
    "REASON",
    "OBJECT",
    "MESSAGE",
  ];
  const grid = textGrid(
    fields,
    shown.map((event) => {
      const involved = objectOf(event.involvedObject) ?? {};
      const cells: unknown[] = statement.allNamespaces ? [stringOf(objectOf(event.metadata)?.namespace) ?? ""] : [];
      cells.push(
        lastSeen(context, event),
        stringOf(event.type) ?? "",
        stringOf(event.reason) ?? "",
        `${(stringOf(involved.kind) ?? "").toLowerCase()}/${stringOf(involved.name) ?? ""}`,
        (stringOf(event.message) ?? "").trim(),
      );
      return cells;
    }),
  );
  if (sorted.length <= KUBERNETES_EVENTS_SHOWN) return grid;
  return {
    ...grid,
    warnings: [
      {
        message: `${sorted.length.toLocaleString("en-US")} events match; the newest 1,000 are shown. Narrow them with --for TYPE/NAME or --types.`,
      },
    ],
  };
}
