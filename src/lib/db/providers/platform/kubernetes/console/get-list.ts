/**
 * `get` shown as a table: the list form of one type, paged by the grid through a row window, and the named form,
 * one request per name. The columns are the server's Table columns (`-o wide` adds the ones of a priority above 0),
 * kubectl's NAMESPACE column with -A, LABELS with --show-labels and one column per -L key; `-o name` is one column of
 * `kind.group/name`.
 *
 * `includeObject=None` unless a column needs the object's metadata (-A for its namespace, --show-labels, -L, or
 * `-o name` of a kind whose Name cell holds more than the name); then
 * `includeObject=Metadata`, and every page is redacted before a cell is written, so a Secret's last-applied
 * annotation never reaches a label or a cell. A page with metadata that meets the 16 MiB cap is read again once with
 * half the page size.
 *
 * The window: the grid asks for rows `[offset, offset + limit)`, and a statement reads at most 5,000 rows, so the
 * route's probe may read the 5,001st and an offset at or past 5,000 answers a sentence to narrow the list.
 */
import { QueryError } from "@/lib/db/errors";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { QueryWarning } from "@/lib/types";
import { ACCEPT_TABLE } from "../client";
import type { IndexedResource } from "../discovery";
import { KubernetesRequestError } from "../errors";
import { builtInKind } from "../kinds";
import { KUBERNETES_MAX_STATEMENT_ROWS, KUBERNETES_PAGE_SIZE, KUBERNETES_TYPE } from "../limits";
import { redactResponse } from "../redaction";
import { cellOf, type KubeTable, parseTable, scanTable, type TableColumn, type TableRow, tableGrid } from "../table";
import {
  byCodeUnit,
  inTurn,
  type KubectlContext,
  type KubectlGrid,
  namespaceFor,
  objectOf,
  requestTimeoutMs,
  resolveType,
} from "./context";
import type { KubectlStatement } from "./parse";

export type GetStatement = Extract<KubectlStatement, { readonly command: "get" }>;

/** The rows a grid page asks for. */
export interface RowWindow {
  readonly offset: number;
  readonly limit: number;
}

/** The sentence for a window that starts past the rows a statement may read. */
export const ROWS_CAP_SENTENCE =
  "This list holds more than 5,000 objects, the most one statement reads: narrow it with -l or --field-selector, or name a namespace with -n.";

const BOUNDED_WARNING: QueryWarning = {
  message:
    "The list holds more than 5,000 objects; Studio shows the first 5,000, the most one statement reads. Narrow it with -l or --field-selector.",
};

/** Whether the kind's Table printer writes more than the name in the Name cell (a StorageClass's ` (default)`). */
function decoratedName(resource: Pick<IndexedResource, "resource" | "group">): boolean {
  const entry = builtInKind(resource.resource);
  return entry?.decoratedName === true && entry.group === resource.group;
}

/** Whether a column of the statement needs each object's metadata. */
export function needsMetadata(
  statement: GetStatement,
  resource: Pick<IndexedResource, "namespaced" | "resource" | "group">,
): boolean {
  return (
    (statement.allNamespaces && resource.namespaced) ||
    statement.showLabels ||
    statement.labelColumns.length > 0 ||
    (statement.output === "name" && decoratedName(resource))
  );
}

/** The deadline of each request: the time the statement has left, or --request-timeout's when that is sooner. */
export function callOf(context: KubectlContext, statement: GetStatement) {
  const call = context.call();
  return statement.requestTimeoutSeconds === undefined
    ? call
    : { ...call, timeoutMs: Math.min(call.timeoutMs, requestTimeoutMs(context, statement.requestTimeoutSeconds)) };
}

/** One page reader of the statement's list as a Table: redacted, parsed. */
export function listPageReader(
  context: KubectlContext,
  statement: GetStatement,
  resource: IndexedResource,
  metadata: boolean,
) {
  const namespace = namespaceFor(context, resource, statement);
  return async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target: resource,
        ...(namespace === undefined ? {} : { namespace }),
        query: {
          limit: page.limit,
          includeObject: metadata ? "Metadata" : "None",
          ...(statement.labelSelector === undefined ? {} : { labelSelector: statement.labelSelector }),
          ...(statement.fieldSelector === undefined ? {} : { fieldSelector: statement.fieldSelector }),
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...callOf(context, statement), accept: ACCEPT_TABLE },
    );
    return parseTable(redactResponse(resource, body));
  };
}

function metadataOf(row: TableRow): Readonly<Record<string, unknown>> {
  return objectOf(row.object?.metadata) ?? {};
}

/** kubectl's LABELS cell: `key=value` pairs sorted by key, or `<none>`. */
function labelsCell(row: TableRow): string {
  const labels = objectOf(metadataOf(row).labels) ?? {};
  const keys = Object.keys(labels).sort(byCodeUnit);
  return keys.length === 0 ? "<none>" : keys.map((key) => `${key}=${String(labels[key])}`).join(",");
}

/** kubectl's -L column header: the key's last path segment, upper-cased. */
function labelHeader(key: string): string {
  return (key.split("/").pop() as string).toUpperCase();
}

/** The `kind.group/name` of `-o name`, as kubectl prints it. */
function qualifiedName(resource: Pick<IndexedResource, "kind" | "group">, name: unknown): string {
  const kind = resource.kind.toLowerCase();
  return `${resource.group === "" ? kind : `${kind}.${resource.group}`}/${String(name)}`;
}

/** The grid of a statement's rows: the Table's columns and the ones its flags add. */
export function gridOf(
  statement: GetStatement,
  resource: IndexedResource,
  table: Pick<KubeTable, "columns">,
  rows: readonly TableRow[],
): KubectlGrid {
  if (statement.output === "name") {
    return {
      fields: ["name"],
      rows: rows.map((row) => ({ name: qualifiedName(resource, metadataOf(row).name ?? cellOf(table, row, "Name")) })),
      columnTypes: { name: "string" },
    };
  }
  const base = tableGrid(table, rows, { wide: statement.output === "wide" });
  const columns: {
    readonly name: string;
    readonly type: string;
    readonly cell: (row: TableRow, index: number) => unknown;
  }[] = [];
  if (statement.allNamespaces && resource.namespaced)
    columns.push({ name: "NAMESPACE", type: "string", cell: (row) => metadataOf(row).namespace ?? null });
  for (const field of base.fields)
    columns.push({ name: field, type: base.columnTypes[field], cell: (_row, index) => base.rows[index][field] });
  if (statement.showLabels) columns.push({ name: "LABELS", type: "string", cell: labelsCell });
  for (const key of statement.labelColumns)
    columns.push({
      name: labelHeader(key),
      type: "string",
      cell: (row) => String((objectOf(metadataOf(row).labels) ?? {})[key] ?? ""),
    });
  const names = uniqueFieldNames(columns.map((column) => column.name));
  return {
    fields: names,
    rows: rows.map((row, index) =>
      Object.fromEntries(columns.map((column, at) => [names[at], column.cell(row, index)])),
    ),
    columnTypes: Object.fromEntries(columns.map((column, at) => [names[at], column.type])),
  };
}

/** The list form: the window's rows, or the first 5,000 when no window was asked for. */
export async function getList(
  context: KubectlContext,
  statement: GetStatement,
  window: RowWindow | undefined,
): Promise<KubectlGrid> {
  const resource = await resolveType(context, statement.type);
  const metadata = needsMetadata(statement, resource);
  const read = listPageReader(context, statement, resource, metadata);
  if (window !== undefined && window.offset >= KUBERNETES_MAX_STATEMENT_ROWS)
    throw new QueryError(ROWS_CAP_SENTENCE, KUBERNETES_TYPE);
  const offset = window?.offset ?? 0;
  // The route's probe asks for one row past the page, so the 5,001st row may be read and never shown.
  const end =
    window === undefined
      ? KUBERNETES_MAX_STATEMENT_ROWS
      : Math.min(offset + window.limit, KUBERNETES_MAX_STATEMENT_ROWS + 1);
  const scan = await scanTable(read, {
    offset,
    limit: end - offset,
    pageSize: KUBERNETES_PAGE_SIZE,
    halveOnTooLarge: metadata,
  });
  const grid = gridOf(statement, resource, scan, scan.rows);
  if (window === undefined && scan.more) return { ...grid, warnings: [BOUNDED_WARNING], bounded: true };
  return grid;
}

/** The named form: one Table read per name, in the order named; a missing one is skipped with --ignore-not-found. */
export async function getNamed(context: KubectlContext, statement: GetStatement): Promise<KubectlGrid> {
  const resource = await resolveType(context, statement.type);
  const namespace = namespaceFor(context, resource, statement);
  const metadata = needsMetadata(statement, resource);
  const tables = await inTurn(statement.names, async (name) => {
    try {
      const body = await context.surface.client.json(
        {
          op: "get",
          target: resource,
          ...(namespace === undefined ? {} : { namespace }),
          name,
          includeObject: metadata ? "Metadata" : "None",
        },
        { ...callOf(context, statement), accept: ACCEPT_TABLE },
      );
      return parseTable(redactResponse(resource, body));
    } catch (error) {
      if (
        statement.ignoreNotFound &&
        error instanceof KubernetesRequestError &&
        error.status === 404 &&
        !error.typeMissing
      )
        return undefined;
      throw error;
    }
  });
  const found = tables.filter((table): table is KubeTable => table !== undefined);
  const columns: readonly TableColumn[] = found[0]?.columns ?? [
    { name: "Name", type: "string", format: "name", priority: 0 },
  ];
  return gridOf(
    statement,
    resource,
    { columns },
    found.flatMap((table) => table.rows),
  );
}
