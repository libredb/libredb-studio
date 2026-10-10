/**
 * The server-side Table: reading a `meta.k8s.io` Table answer (or the plain list a server that cannot render one
 * answers instead), mapping it to one Studio grid, and the paged walk over `continue` that the tree's capped listings
 * and the console's row window both read through.
 *
 * Cells stay as the server formatted them (`6 (3m29s ago)`, `<none>`); only the column type decides how a cell is
 * typed: `integer` and `number` cells are numbers, `boolean` cells booleans, every other cell text.
 */
import { QueryError } from "@/lib/db/errors";
import { KubernetesRequestError, KubernetesResponseTooLargeError } from "./errors";
import { KUBERNETES_MAX_EMPTY_PAGES, KUBERNETES_MAX_RESPONSE_BYTES, KUBERNETES_TYPE } from "./limits";

export interface TableColumn {
  readonly name: string;
  readonly type: string;
  readonly format: string;
  /** 0 for the default columns; above 0 for the columns `-o wide` adds. */
  readonly priority: number;
}

export interface TableRow {
  readonly cells: readonly unknown[];
  /** The row's object as `includeObject` asked for it: absent with `None`, metadata with `Metadata`. */
  readonly object?: Readonly<Record<string, unknown>>;
}

export interface KubeTable {
  readonly columns: readonly TableColumn[];
  readonly rows: readonly TableRow[];
  /** The `continue` token of the next page; absent on the last page. */
  readonly continueToken?: string;
  readonly resourceVersion?: string;
}

export interface TableGrid {
  readonly fields: string[];
  readonly rows: Record<string, unknown>[];
  readonly columnTypes: Record<string, string>;
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const NOT_A_TABLE = "The API server answered with neither a Table nor a list, so there is nothing to show.";

function listMeta(body: Json): Pick<KubeTable, "continueToken" | "resourceVersion"> {
  const metadata = isObject(body.metadata) ? body.metadata : {};
  const token = metadata.continue;
  const version = metadata.resourceVersion;
  return {
    ...(typeof token === "string" && token !== "" ? { continueToken: token } : {}),
    ...(typeof version === "string" && version !== "" ? { resourceVersion: version } : {}),
  };
}

function column(definition: unknown): TableColumn {
  const entry = isObject(definition) ? definition : {};
  return {
    name: typeof entry.name === "string" ? entry.name : "",
    type: typeof entry.type === "string" ? entry.type : "string",
    format: typeof entry.format === "string" ? entry.format : "",
    priority: typeof entry.priority === "number" ? entry.priority : 0,
  };
}

/** An array, or no entries for the null or absent field an empty answer carries; anything else is not a list. */
function entries(value: unknown): readonly unknown[] | undefined {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : undefined;
}

/**
 * A Table answer, or a list answer read as a two-column Table (Name and Created), which is what a server that cannot
 * render a Table for a resource sends for the Accept's plain-JSON fallback. An empty answer may carry `rows: null`
 * (the default Table convertor's) or `items: null`: both read as no rows.
 */
export function parseTable(body: unknown): KubeTable {
  if (!isObject(body)) throw new QueryError(NOT_A_TABLE, KUBERNETES_TYPE);
  const rows = entries(body.rows);
  if (body.kind === "Table" && Array.isArray(body.columnDefinitions) && rows !== undefined) {
    return {
      columns: body.columnDefinitions.map(column),
      rows: rows.filter(isObject).map((row) => ({
        cells: Array.isArray(row.cells) ? row.cells : [],
        ...(isObject(row.object) ? { object: row.object } : {}),
      })),
      ...listMeta(body),
    };
  }
  const items = "items" in body ? entries(body.items) : undefined;
  if (items !== undefined) {
    return {
      columns: [
        { name: "Name", type: "string", format: "name", priority: 0 },
        { name: "Created", type: "string", format: "date-time", priority: 0 },
      ],
      rows: items.filter(isObject).map((item) => {
        const metadata = isObject(item.metadata) ? item.metadata : {};
        return { cells: [metadata.name ?? null, metadata.creationTimestamp ?? null], object: item };
      }),
      ...listMeta(body),
    };
  }
  throw new QueryError(NOT_A_TABLE, KUBERNETES_TYPE);
}

/** The cell of a named column, or undefined when the Table has no such column. */
export function cellOf(table: Pick<KubeTable, "columns">, row: TableRow, name: string): unknown {
  const index = table.columns.findIndex((entry) => entry.name === name);
  return index === -1 ? undefined : row.cells[index];
}

function typedCell(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if ((type === "integer" || type === "number") && typeof value === "number") return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One grid from a Table: the default columns, and the wide ones with `wide`. */
export function tableGrid(
  table: Pick<KubeTable, "columns">,
  rows: readonly TableRow[],
  options: { readonly wide: boolean },
): TableGrid {
  const shown = table.columns
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => options.wide || entry.priority === 0);
  const columnTypes: Record<string, string> = {};
  for (const { entry } of shown) columnTypes[entry.name] = entry.type;
  return {
    fields: shown.map(({ entry }) => entry.name),
    rows: rows.map((row) => {
      const record: Record<string, unknown> = {};
      for (const { entry, index } of shown) record[entry.name] = typedCell(entry.type, row.cells[index]);
      return record;
    }),
    columnTypes,
  };
}

/** One page of a list: the caller builds the request, redacts the answer and parses it. */
export type TablePageReader = (page: { readonly continueToken?: string; readonly limit: number }) => Promise<KubeTable>;

export interface TableWindow {
  /** Rows to skip from the start of the list. */
  readonly offset: number;
  /** Rows to return after the offset. */
  readonly limit: number;
  /** Objects per request. */
  readonly pageSize: number;
  /** Read again once with half the page size when a page is past the byte cap (pages that carry metadata). */
  readonly halveOnTooLarge?: boolean;
}

export interface TableScan {
  /** The first page's columns. */
  readonly columns: readonly TableColumn[];
  /** The rows of the window, at most `limit`. */
  readonly rows: readonly TableRow[];
  /** Whether the list holds rows past the window. */
  readonly more: boolean;
  /** The first page's resourceVersion, which a watch starts from. */
  readonly resourceVersion?: string;
}

/** A continue token sent back unchanged: a server that does so would be asked for the same page for ever. */
const REPEATED_CONTINUE_SENTENCE =
  "The API server answered a list page with the continue token Studio had just sent, so the list does not advance; Studio stops rather than read the same page again.";

/** Too many pages with no object and a continue token: a fresh token each time is no progress either. */
export const EMPTY_PAGES_SENTENCE = `The API server answered ${KUBERNETES_MAX_EMPTY_PAGES} pages of this list with no objects and a continue token, so the list does not advance; Studio stops rather than read on.`;

function isExpired(error: unknown): boolean {
  return error instanceof KubernetesRequestError && error.status === 410;
}

async function walk(read: TablePageReader, window: TableWindow, pageSize: number): Promise<TableScan> {
  const wanted = window.offset + window.limit;
  const kept: TableRow[] = [];
  let seen = 0;
  let columns: readonly TableColumn[] = [];
  let resourceVersion: string | undefined;
  let token: string | undefined;
  let first = true;
  let emptyPages = 0;
  for (;;) {
    // Never more rows than the window still needs: a walk one row past a cap asks for that one row, not a full page.
    const limit = Math.min(pageSize, wanted - seen);
    const page = await read({ ...(token === undefined ? {} : { continueToken: token }), limit });
    if (first) {
      columns = page.columns;
      resourceVersion = page.resourceVersion;
      first = false;
    }
    for (const row of page.rows) {
      if (seen >= window.offset && seen < wanted) kept.push(row);
      seen += 1;
    }
    const sent = token;
    token = page.continueToken;
    if (seen >= wanted || token === undefined) {
      return {
        columns,
        rows: kept,
        more: seen > wanted || token !== undefined,
        ...(resourceVersion === undefined ? {} : { resourceVersion }),
      };
    }
    // A page with rows always advances the walk; only a page without them can repeat for ever.
    if (token === sent) throw new QueryError(REPEATED_CONTINUE_SENTENCE, KUBERNETES_TYPE);
    if (page.rows.length === 0) {
      emptyPages += 1;
      if (emptyPages >= KUBERNETES_MAX_EMPTY_PAGES) throw new QueryError(EMPTY_PAGES_SENTENCE, KUBERNETES_TYPE);
    }
  }
}

/**
 * Reads the rows `[offset, offset + limit)` of a list by chaining `continue`. An expired `continue` (HTTP 410)
 * restarts the walk once from the beginning; a second answers its sentence. With `halveOnTooLarge`, a page past the
 * byte cap restarts the walk once with half the page size; a second answers a sentence to narrow.
 */
export async function scanTable(read: TablePageReader, window: TableWindow): Promise<TableScan> {
  // The API reads limit=0 as no limit at all, so a window must ask for at least one row.
  if (!Number.isInteger(window.limit) || window.limit < 1)
    throw new QueryError("A Table window reads at least one row.", KUBERNETES_TYPE);
  return scanFrom(read, window, window.pageSize, { restarted: false, halved: false });
}

async function scanFrom(
  read: TablePageReader,
  window: TableWindow,
  pageSize: number,
  state: { readonly restarted: boolean; readonly halved: boolean },
): Promise<TableScan> {
  try {
    return await walk(read, window, pageSize);
  } catch (error) {
    if (isExpired(error) && !state.restarted) return scanFrom(read, window, pageSize, { ...state, restarted: true });
    if (!(error instanceof KubernetesResponseTooLargeError) || window.halveOnTooLarge !== true) throw error;
    if (state.halved || pageSize === 1)
      throw new QueryError(
        `A page of ${pageSize} objects with their metadata is still larger than ${KUBERNETES_MAX_RESPONSE_BYTES / (1024 * 1024)} MiB; narrow the list with -n, -l or --field-selector.`,
        KUBERNETES_TYPE,
      );
    return scanFrom(read, window, Math.max(1, Math.floor(pageSize / 2)), { ...state, halved: true });
  }
}
