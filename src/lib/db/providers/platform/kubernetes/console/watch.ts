/**
 * `get TYPE -w`: a bounded window, never a stream. The list is read first, walked with `continue` within the 5,000
 * rows a statement reads, then one watch from the list's `resourceVersion` whose `timeoutSeconds` is the window, so
 * the server ends it; the client's deadline is the window plus 5 s. The grid is the listed rows, then the window's
 * events, under one first column that names the event (empty for a listed row); the columns are the list's Table.
 *
 * A `BOOKMARK` event is never printed. An in-band `ERROR` event ends the window with a sentence from its code and
 * reason alone, and nothing is sent again. A window past 8 MiB, a list cut by the 5,000 cap, and listed rows and
 * events together past 5,000 rows answer sentences to narrow the statement. Every event is redacted on the request before a cell is written.
 */
import { QueryError } from "@/lib/db/errors";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { ACCEPT_TABLE } from "../client";
import { KubernetesResponseTooLargeError, type KubernetesRequestContext, watchEventFailure } from "../errors";
import {
  KUBERNETES_MAX_STATEMENT_ROWS,
  KUBERNETES_PAGE_SIZE,
  KUBERNETES_TYPE,
  KUBERNETES_WATCH_WINDOW_BYTES,
  KUBERNETES_WATCH_WINDOW_SECONDS,
  KUBERNETES_WINDOW_MARGIN_MS,
} from "../limits";
import { redactResponse } from "../redaction";
import { parseTable, scanTable, type TableColumn, type TableRow } from "../table";
import {
  type KubectlContext,
  type KubectlGrid,
  namespaceFor,
  objectOf,
  requestTimeoutMs,
  resolveType,
  STATEMENT_DEADLINE_SENTENCE,
} from "./context";
import { type GetStatement, gridOf, listPageReader, needsMetadata } from "./get-list";

export const WATCH_LIST_CAP_SENTENCE =
  "The list holds more than 5,000 objects, so get -w cannot start its window from the whole list: narrow it with -l or --field-selector, or name a namespace with -n.";

export const WATCH_BYTES_SENTENCE =
  "The watch window received more than 8 MiB of events: narrow it with -l or --field-selector, or shorten it with --request-timeout.";

export const WATCH_ROWS_SENTENCE =
  "The listed rows and the watch window's events pass the 5,000 rows one statement reads: narrow it with -l or --field-selector, or shorten it with --request-timeout.";

const NO_RESOURCE_VERSION =
  "The API server listed no resourceVersion, so get -w cannot start its window where the list ended.";

const NOT_JSON = "The watch answered a line that is not JSON, so the window cannot be shown.";

/** The window in seconds: --request-timeout, else 10 s, never closer than 5 s to the query timeout. */
function windowSeconds(context: KubectlContext, statement: GetStatement): number {
  if (statement.requestTimeoutSeconds !== undefined)
    return Math.floor(requestTimeoutMs(context, statement.requestTimeoutSeconds) / 1000);
  const most = Math.floor((context.queryTimeoutMs - KUBERNETES_WINDOW_MARGIN_MS) / 1000);
  if (most < 1)
    throw new QueryError(
      "The connection's query timeout leaves no room for a watch window: get -w needs a query timeout above 6 s.",
      KUBERNETES_TYPE,
    );
  return Math.min(KUBERNETES_WATCH_WINDOW_SECONDS, most);
}

/**
 * One event's object as Table rows, their cells in the order of the list's columns. The API server sends the column
 * definitions on a watch's first Table event only and null on every later one, so an event's rows are read alone and
 * stand against the list's columns. A plain object fills the Name column (and the Created column of a list read as
 * names) and leaves every other cell empty.
 */
function eventRows(object: unknown, columns: readonly TableColumn[]): readonly TableRow[] {
  const value = objectOf(object) ?? {};
  if (value.kind === "Table") return parseTable({ ...value, columnDefinitions: [] }).rows;
  const metadata = objectOf(value.metadata) ?? {};
  const cells = columns.map((column) =>
    column.name === "Name"
      ? (metadata.name ?? null)
      : column.name === "Created"
        ? (metadata.creationTimestamp ?? null)
        : null,
  );
  return [{ cells, object: value }];
}

export async function getWatch(context: KubectlContext, statement: GetStatement): Promise<KubectlGrid> {
  const resource = await resolveType(context, statement.type);
  const asked = windowSeconds(context, statement);
  const metadata = needsMetadata(statement, resource);
  const scan = await scanTable(listPageReader(context, statement, resource, metadata), {
    offset: 0,
    limit: KUBERNETES_MAX_STATEMENT_ROWS + 1,
    pageSize: KUBERNETES_PAGE_SIZE,
    halveOnTooLarge: metadata,
  });
  if (scan.rows.length > KUBERNETES_MAX_STATEMENT_ROWS) throw new QueryError(WATCH_LIST_CAP_SENTENCE, KUBERNETES_TYPE);
  if (scan.resourceVersion === undefined) throw new QueryError(NO_RESOURCE_VERSION, KUBERNETES_TYPE);
  const namespace = namespaceFor(context, resource, statement);
  const request: KubernetesRequestContext = {
    verb: "watch",
    resource: resource.resource,
    group: resource.group,
    ...(namespace === undefined ? {} : { namespace }),
  };
  // The window ends inside the statement's deadline, so a list that took time to read shortens it.
  const call = context.call();
  const window = Math.min(asked, Math.floor((call.timeoutMs - KUBERNETES_WINDOW_MARGIN_MS) / 1000));
  if (window < 1) throw new QueryError(STATEMENT_DEADLINE_SENTENCE, KUBERNETES_TYPE);
  let text: string;
  try {
    const answer = await context.surface.client.send(
      {
        op: "watch",
        target: resource,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          resourceVersion: scan.resourceVersion,
          timeoutSeconds: window,
          includeObject: metadata ? "Metadata" : "None",
          ...(statement.labelSelector === undefined ? {} : { labelSelector: statement.labelSelector }),
          ...(statement.fieldSelector === undefined ? {} : { fieldSelector: statement.fieldSelector }),
        },
      },
      {
        ...call,
        timeoutMs: window * 1000 + KUBERNETES_WINDOW_MARGIN_MS,
        accept: ACCEPT_TABLE,
        maxResponseBytes: KUBERNETES_WATCH_WINDOW_BYTES,
      },
    );
    text = answer.text;
  } catch (error) {
    if (error instanceof KubernetesResponseTooLargeError) throw new QueryError(WATCH_BYTES_SENTENCE, KUBERNETES_TYPE);
    throw error;
  }
  const events: { readonly type: string; readonly row: TableRow }[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event: Readonly<Record<string, unknown>>;
    try {
      event = objectOf(JSON.parse(line)) ?? {};
    } catch {
      throw new QueryError(NOT_JSON, KUBERNETES_TYPE);
    }
    const type = String(event.type);
    if (type === "BOOKMARK") continue;
    if (type === "ERROR") throw watchEventFailure(request, objectOf(event.object) ?? {});
    const redacted = redactResponse(resource, { type, object: event.object });
    for (const row of eventRows(redacted.object, scan.columns)) events.push({ type, row });
    if (scan.rows.length + events.length > KUBERNETES_MAX_STATEMENT_ROWS)
      throw new QueryError(WATCH_ROWS_SENTENCE, KUBERNETES_TYPE);
  }
  const listed = gridOf(statement, resource, scan, scan.rows);
  const watched = gridOf(
    statement,
    resource,
    scan,
    events.map((event) => event.row),
  );
  const [eventField, ...fields] = uniqueFieldNames(["EVENT", ...listed.fields]);
  // Each row keyed by the renamed fields, its event first.
  const rowOf = (event: string | null, row: Record<string, unknown>): Record<string, unknown> => {
    const keyed: Record<string, unknown> = { [eventField]: event };
    listed.fields.forEach((field, index) => {
      keyed[fields[index]] = row[field];
    });
    return keyed;
  };
  return {
    fields: [eventField, ...fields],
    rows: [
      ...listed.rows.map((row) => rowOf(null, row)),
      ...watched.rows.map((row, index) => rowOf(events[index].type, row)),
    ],
    columnTypes: {
      [eventField]: "string",
      ...Object.fromEntries(
        listed.fields.map((field, index) => [fields[index], listed.columnTypes?.[field] ?? "string"]),
      ),
    },
  };
}
