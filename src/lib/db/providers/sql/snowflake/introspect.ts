/**
 * The Snowflake object surface: the connect statement and its cautions, the tree's containers and ten object kinds,
 * the counts, describe, the inventory, source and health.
 *
 * Every read is one statement handed to a {@link SnowflakeStatementRunner}, so this file names no request, partition
 * or socket. Each sends a single-statement `SHOW`, except a non-view's source, which is one `SELECT GET_DDL(...)` on
 * the user's click; neither needs a running warehouse, as the trial measured (Snowflake 10.37.100, 2026-10-12). Names
 * reach a statement only as double-quoted identifiers and as literals through `quoteLiteral`, never as typed.
 *
 * Two rules of Snowflake's `SHOW` shape the reads:
 *
 * - A tree listing of databases, schemas, tables, views, streams or tasks is sent with `LIMIT 10000` and paged with
 *   `FROM '<last name>'`, and the count's `SHOW TERSE OBJECTS` with `LIMIT 10000` alone, so each answer stays
 *   bounded; the trial answered `SHOW TABLES` and `SHOW TERSE OBJECTS` with all 10,250 rows of a schema without a
 *   `LIMIT`, and `FROM` started after the name it was given (Snowflake 10.37.100, 2026-10-13). Every other listing
 *   has no paging and is sent bare: `SHOW SEQUENCES` answered all 10,250 rows and ignored `LIMIT` and `FROM`, and for
 *   the rest the 10,000-row figure is the reference's, not a measurement.
 * - `SHOW ... LIKE` matches case-insensitively and keeps `_` and `%` as wildcards, with no escape, so a reader of a
 *   `LIKE` answer takes only the row whose `name` equals the name it asked for, and no such row means absent.
 */
import { INVENTORY_LIMIT, INVENTORY_PAIR_LIMIT, INVENTORY_TRUNCATION_REASON } from "@/lib/db/inventory-bounds";
import { applySourceBound, callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseObject,
  HealthInfo,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
} from "@/lib/db/types";
import { quoteLiteral } from "@/lib/sql/values";
import type { ColumnSchema, IndexSchema, QueryWarning } from "@/lib/types";
import { parseCellJson, type SnowflakeCell } from "./decode";
import { SNOWFLAKE, SnowflakeError } from "./errors";
import {
  foldIdentifier,
  SNOWFLAKE_QUERY_TAGS,
  type SnowflakeQueryTag,
  type SnowflakeResult,
  type SnowflakeStatementRunner,
} from "./statements";

/** The rows one page of a pageable `SHOW` asks for, and the bound of the counting `SHOW TERSE OBJECTS`. */
export const SNOWFLAKE_SHOW_PAGE_ROWS = 10_000;
/** The pages a tree listing reads before it stops: 50,000 rows. */
export const SNOWFLAKE_TREE_PAGE_LIMIT = 5;

export const SNOWFLAKE_KIND_IDS = Object.freeze([
  "table",
  "view",
  "stream",
  "task",
  "sequence",
  "stage",
  "file-format",
  "pipe",
  "function",
  "procedure",
] as const);

export type SnowflakeKindId = (typeof SNOWFLAKE_KIND_IDS)[number];

/** Every sentence this surface shows, so the provider doc can quote them and a test read them back. */
export const SNOWFLAKE_INTROSPECT_SENTENCES = Object.freeze({
  treeCap: "Snowflake has more than 50,000 objects of this kind here; Studio shows the first 50,000 by name.",
  countFloor: "Studio counts at most 10,000 objects here, so this is a floor.",
  pairCap: `Snowflake answered a full 10,000-row column listing for this schema, so Studio read the columns of the first ${INVENTORY_PAIR_LIMIT.toLocaleString("en-US")} objects one at a time`,
  secureView: "Snowflake hides a secure view's definition from roles that do not own it.",
  stalled: "Snowflake answered a page of this listing that did not move past the last, so Studio stopped reading it.",
  noWarehouseRow: (wh: string, role: string) =>
    `Snowflake shows no warehouse named ${wh} to role ${role}. Check the name, and that the role has USAGE on it.`,
  notResuming: (wh: string) =>
    `Warehouse ${wh} is suspended and does not resume on its own, so queries fail until someone resumes it.`,
  emptyWarehouse:
    "Warehouse is empty, so queries use the user's default warehouse and fail if the user has none. Browsing works without one.",
  unknownKind: (kind: string) => `Snowflake has no object kind "${kind}" in Studio.`,
  badLimit: (limit: number) => `A Snowflake bulk column read limit must be a positive whole number, received ${limit}.`,
  noColumns: (objects: readonly string[]) =>
    `Snowflake listed no columns for ${objects.map((name) => `"${name}"`).join(", ")}, so ${objects.length === 1 ? "it was" : "they were"} left out`,
  notShown: (object: string) => `Snowflake shows no object named "${object}" in this schema to this role.`,
  noDefinition: (object: string) => `Snowflake answered no definition for "${object}".`,
  noSource: (kind: string) => `Snowflake objects of kind "${kind}" have no definition Studio reads.`,
  sourceLabel: "Definition",
  unreadableArguments: (name: string) =>
    `Snowflake listed the routine "${name}" with an argument list Studio cannot read.`,
});

/** How one kind is listed: its `SHOW` noun, and whether that command pages. */
interface KindRead {
  readonly noun: string;
  readonly paged: boolean;
}

const KIND_READS: Readonly<Record<SnowflakeKindId, KindRead>> = Object.freeze({
  table: { noun: "TABLES", paged: true },
  view: { noun: "VIEWS", paged: true },
  stream: { noun: "STREAMS", paged: true },
  task: { noun: "TASKS", paged: true },
  sequence: { noun: "SEQUENCES", paged: false },
  stage: { noun: "STAGES", paged: false },
  "file-format": { noun: "FILE FORMATS", paged: false },
  pipe: { noun: "PIPES", paged: false },
  // SHOW FUNCTIONS would list the built-ins too; SHOW PROCEDURES does, and `readListing` drops them.
  function: { noun: "USER FUNCTIONS", paged: false },
  procedure: { noun: "PROCEDURES", paged: false },
});

/** The kinds whose path segment carries the argument types, since Snowflake overloads them by those. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set(["function", "procedure"]);

/** The `SHOW TERSE OBJECTS` `kind` values each counted kind is made of; any other value is not counted. */
const COUNTED_KINDS: Readonly<Record<"table" | "view", ReadonlySet<string>>> = Object.freeze({
  table: new Set(["TABLE", "TRANSIENT", "TEMPORARY"]),
  view: new Set(["VIEW", "MATERIALIZED_VIEW"]),
});

/** A table's flags and the word each shows as, in the order they are joined. */
const TABLE_FLAGS: readonly (readonly [string, string])[] = [
  ["is_external", "external"],
  ["is_dynamic", "dynamic"],
  ["is_iceberg", "iceberg"],
  ["is_hybrid", "hybrid"],
  ["is_event", "event"],
];
const VIEW_FLAGS: readonly (readonly [string, string])[] = [
  ["is_materialized", "materialized"],
  ["is_secure", "secure"],
];
/** The `SHOW TABLES` `kind` values a reader should know about; a permanent table's `TABLE` shows nothing. */
const TABLE_KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  TRANSIENT: "transient",
  TEMPORARY: "temporary",
});

// ============================================================================
// Statement text
// ============================================================================

/** A Snowflake identifier, always double-quoted, with each quote doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return quoteLiteral(value, SNOWFLAKE);
}

function inSchema(container: readonly [string, string]): string {
  return `IN SCHEMA ${quoteIdent(container[0])}.${quoteIdent(container[1])}`;
}

function kindRead(kind: string): KindRead {
  if (!Object.hasOwn(KIND_READS, kind)) {
    throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.unknownKind(kind));
  }
  return KIND_READS[kind as SnowflakeKindId];
}

// ============================================================================
// Cells
// ============================================================================

export function cellText(cell: SnowflakeCell | undefined): string {
  if (cell === null || cell === undefined) return "";
  return typeof cell === "string" ? cell : String(cell);
}

/** A `SHOW` flag, which Snowflake writes as `Y` or `N` for some commands and `true` or `false` for others. */
export function cellFlag(cell: SnowflakeCell | undefined): boolean {
  if (cell === true) return true;
  return typeof cell === "string" && /^(?:y|true)$/i.test(cell);
}

/** A non-negative whole number, or undefined for NULL or anything else. */
export function cellWholeNumber(cell: SnowflakeCell | undefined): number | undefined {
  const value = typeof cell === "number" ? cell : typeof cell === "string" && /^\d+$/.test(cell) ? Number(cell) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// ============================================================================
// Paging
// ============================================================================

type Row = Record<string, SnowflakeCell>;

/** Why a listing stopped: it read everything, hit the page limit, or met a page that did not move. */
type ListingStop = "end" | "pageLimit" | "stalled";

interface Listing {
  readonly rows: readonly Row[];
  readonly stop: ListingStop;
}

/**
 * A pageable `SHOW` read page by page: `LIMIT 10000`, then `LIMIT 10000 FROM '<last name>'` while a page comes back
 * full and fewer than `pageLimit` pages were sent. A first row repeating the previous page's last name is dropped,
 * a page holding nothing past the cursor ends the read, and a page whose last name is not past the previous last
 * stops it, so a cursor that does not move cannot loop.
 */
async function pagedShow(
  run: SnowflakeStatementRunner,
  base: string,
  tag: SnowflakeQueryTag,
  pageLimit: number,
): Promise<Listing> {
  const rows: Row[] = [];
  let last: string | null = null;
  for (let pages = 1; ; pages += 1) {
    const sql: string =
      last === null
        ? `${base} LIMIT ${SNOWFLAKE_SHOW_PAGE_ROWS}`
        : `${base} LIMIT ${SNOWFLAKE_SHOW_PAGE_ROWS} FROM ${literal(last)}`;
    // oxlint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's last name.
    const page: Row[] = (await run(sql, tag)).rows;
    // The trial's `FROM` starts after the name it is given, so no page repeats the cursor row; dropping one that
    // does costs one comparison and keeps a repeat from being listed twice.
    const fresh = last !== null && cellText(page[0]?.name) === last ? page.slice(1) : page;
    if (last !== null) {
      // Nothing past the cursor is the end of the listing.
      if (fresh.length === 0) return { rows, stop: "end" };
      if (cellText(fresh.at(-1)?.name) <= last) return { rows, stop: "stalled" };
    }
    rows.push(...fresh);
    if (page.length < SNOWFLAKE_SHOW_PAGE_ROWS) return { rows, stop: "end" };
    if (pages >= pageLimit) return { rows, stop: "pageLimit" };
    last = cellText(page.at(-1)?.name);
  }
}

/** A `SHOW` with no paging: one statement, no `LIMIT`, every row it answers. */
async function unpagedShow(run: SnowflakeStatementRunner, sql: string, tag: SnowflakeQueryTag): Promise<Listing> {
  return { rows: (await run(sql, tag)).rows, stop: "end" };
}

// ============================================================================
// Containers, listings and counts
// ============================================================================

/** The databases the role sees; the configured database, after Snowflake's fold, is the session default. */
export async function listDatabases(
  run: SnowflakeStatementRunner,
  sessionDatabase: string | undefined,
): Promise<Container[]> {
  const { rows } = await pagedShow(run, "SHOW DATABASES", SNOWFLAKE_QUERY_TAGS.tree, SNOWFLAKE_TREE_PAGE_LIMIT);
  const configured = sessionDatabase ? foldIdentifier(sessionDatabase) : null;
  return rows.map((row) => {
    const name = cellText(row.name);
    return { path: [name], name, level: 0, isSessionDefault: name === configured };
  });
}

/**
 * One database's schemas, never the account's. `sessionSchema` is the configured schema, which the caller passes
 * only for the configured database, so only that database's schema is marked.
 */
export async function listSchemas(
  run: SnowflakeStatementRunner,
  database: string,
  sessionSchema: string | undefined,
): Promise<Container[]> {
  const base = `SHOW SCHEMAS IN DATABASE ${quoteIdent(database)}`;
  const { rows } = await pagedShow(run, base, SNOWFLAKE_QUERY_TAGS.tree, SNOWFLAKE_TREE_PAGE_LIMIT);
  const configured = sessionSchema ? foldIdentifier(sessionSchema) : null;
  return rows.map((row) => {
    const name = cellText(row.name);
    return { path: [database, name], name, level: 1, isSessionDefault: name === configured };
  });
}

/**
 * A routine's path segment: its name and its argument types, read from `arguments`
 * (`F(NUMBER, VARCHAR) RETURN NUMBER` gives `F(NUMBER, VARCHAR)`). The list is the balanced group that closes the
 * text before ` RETURN `, so neither a type's own parentheses nor a name holding one can move it.
 */
function routineSegment(name: string, argumentsText: string): string {
  const returnAt = argumentsText.lastIndexOf(" RETURN ");
  const head = returnAt === -1 ? argumentsText : argumentsText.slice(0, returnAt);
  if (!head.endsWith(")")) throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.unreadableArguments(name));
  let depth = 0;
  for (let index = head.length - 1; index >= 0; index -= 1) {
    if (head[index] === ")") depth += 1;
    else if (head[index] === "(") depth -= 1;
    if (depth === 0) return `${name}${head.slice(index)}`;
  }
  throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.unreadableArguments(name));
}

function statusOf(kind: string, row: Row): string | undefined {
  const words: string[] = [];
  if (kind === "table") {
    const kindWord = TABLE_KIND_WORDS[cellText(row.kind)];
    if (kindWord !== undefined) words.push(kindWord);
    for (const [column, word] of TABLE_FLAGS) if (cellFlag(row[column])) words.push(word);
  } else if (kind === "view") {
    for (const [column, word] of VIEW_FLAGS) if (cellFlag(row[column])) words.push(word);
  }
  return words.length === 0 ? undefined : words.join(", ");
}

/** One listing row as an object: `rows` is a hint for a table, and `bytes` is scan bytes, so it is no size. */
function objectOf(container: readonly [string, string], kind: string, row: Row): DatabaseObject {
  const name = cellText(row.name);
  const segment = ROUTINE_KINDS.has(kind) ? routineSegment(name, cellText(row.arguments)) : name;
  const status = statusOf(kind, row);
  const rowCount = kind === "table" ? cellWholeNumber(row.rows) : undefined;
  return {
    path: [container[0], container[1], segment],
    name,
    kind,
    ...(status === undefined ? {} : { status }),
    ...(rowCount === undefined ? {} : { rowCount }),
  };
}

/**
 * One kind's listing in one schema, paged up to `pageLimit` pages when the command pages. A built-in row
 * (`is_builtin` Y) is not the schema's: the trial answered `SHOW PROCEDURES IN SCHEMA` with every built-in
 * `SYSTEM$` procedure, an empty `schema_name` on each.
 */
async function readListing(
  run: SnowflakeStatementRunner,
  container: readonly [string, string],
  kind: string,
  pageLimit: number,
  tag: SnowflakeQueryTag,
): Promise<{ readonly objects: DatabaseObject[]; readonly stop: ListingStop }> {
  const read = kindRead(kind);
  const base = `SHOW ${read.noun} ${inSchema(container)}`;
  const listing = read.paged ? await pagedShow(run, base, tag, pageLimit) : await unpagedShow(run, base, tag);
  const own = listing.rows.filter((row) => !cellFlag(row.is_builtin));
  return { objects: own.map((row) => objectOf(container, kind, row)), stop: listing.stop };
}

/**
 * One kind of one schema. The provider contract carries no truncation here, so a paged listing stops at 50,000 rows
 * and answers what it read; `describeObjects` reports the cap.
 */
export async function listObjects(
  run: SnowflakeStatementRunner,
  container: readonly [string, string],
  kind: string,
): Promise<DatabaseObject[]> {
  return (await readListing(run, container, kind, SNOWFLAKE_TREE_PAGE_LIMIT, SNOWFLAKE_QUERY_TAGS.tree)).objects;
}

/**
 * Tables and views from one `SHOW TERSE OBJECTS ... LIMIT 10000`, so a full answer makes each count a floor. Every
 * other kind is left out of the record: its folder shows no badge and its own `SHOW` runs only when it is opened.
 */
export async function countObjects(
  run: SnowflakeStatementRunner,
  container: readonly [string, string],
): Promise<Record<string, KindCount>> {
  const sql = `SHOW TERSE OBJECTS ${inSchema(container)} LIMIT ${SNOWFLAKE_SHOW_PAGE_ROWS}`;
  const { rows } = await run(sql, SNOWFLAKE_QUERY_TAGS.tree);
  const sampled = rows.length >= SNOWFLAKE_SHOW_PAGE_ROWS;
  const counts: Record<string, KindCount> = {};
  for (const [kind, values] of Object.entries(COUNTED_KINDS)) {
    const count = rows.filter((row) => values.has(cellText(row.kind))).length;
    counts[kind] = sampled ? { count, sampledFrom: SNOWFLAKE_INTROSPECT_SENTENCES.countFloor } : { count };
  }
  return counts;
}

// ============================================================================
// The connect statement and its cautions
// ============================================================================

function hasWarehouse(warehouse: string | undefined): warehouse is string {
  return warehouse !== undefined && warehouse !== "";
}

/** A name without one pair of surrounding double quotes, with `""` read as `"`; a bare name as typed. */
function unquoted(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) return name.slice(1, -1).replaceAll('""', '"');
  return name;
}

/** `SHOW WAREHOUSES LIKE '<name>'` with Warehouse set, else `SHOW DATABASES LIMIT 1`; neither needs a warehouse. */
export function connectStatement(warehouse: string | undefined): string {
  return hasWarehouse(warehouse) ? `SHOW WAREHOUSES LIKE ${literal(unquoted(warehouse))}` : "SHOW DATABASES LIMIT 1";
}

/** The row whose `name` equals the folded configured warehouse, or null. */
export function warehouseRow(result: SnowflakeResult, warehouse: string): Record<string, SnowflakeCell> | null {
  const name = foldIdentifier(warehouse);
  return result.rows.find((row) => row.name === name) ?? null;
}

/** What `connect()`'s answer says is wrong, and nothing when it is not. */
export function connectCautions(result: SnowflakeResult, warehouse: string | undefined, role: string): QueryWarning[] {
  if (!hasWarehouse(warehouse)) return [{ message: SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse }];
  const row = warehouseRow(result, warehouse);
  if (row === null) return [{ message: SNOWFLAKE_INTROSPECT_SENTENCES.noWarehouseRow(warehouse, role) }];
  if (cellText(row.state) === "SUSPENDED" && !cellFlag(row.auto_resume)) {
    return [{ message: SNOWFLAKE_INTROSPECT_SENTENCES.notResuming(warehouse) }];
  }
  return [];
}

// ============================================================================
// Describe
// ============================================================================

/** The kinds that have columns; every other declared kind describes as none. */
const COLUMN_KINDS: Readonly<Record<string, string>> = Object.freeze({ table: "TABLE", view: "VIEW" });

function qualified(path: readonly [string, string, string]): string {
  return `${quoteIdent(path[0])}.${quoteIdent(path[1])}.${quoteIdent(path[2])}`;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The catalog spelling of each part of a structured type, or null when any part is unreadable. */
function spelledParts(parts: readonly unknown[]): string[] | null {
  const spelled = parts.map(typeSpelling);
  return spelled.every((part): part is string => part !== null) ? spelled : null;
}

/** An OBJECT's fields as `name TYPE`, or null when there are none or one is unreadable. */
function spelledFields(fields: unknown): string[] | null {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const named = fields.map((field) => (isObject(field) && typeof field.fieldName === "string" ? field : null));
  if (named.some((field) => field === null)) return null;
  const types = spelledParts(named.map((field) => field?.fieldType));
  return types === null ? null : types.map((type, index) => `${named[index]?.fieldName} ${type}`);
}

/**
 * One `data_type` object as DESCRIBE TABLE spells the type: `FIXED` as `NUMBER(p,s)`, `REAL` as `FLOAT`, `TEXT` as
 * `VARCHAR(n)`, `BINARY(n)`, `DECFLOAT(p)`, a time or timestamp with its scale, a structured `OBJECT`, `ARRAY` or `MAP`
 * with its field, element, key and value types, `VECTOR(<element>, <dimension>)`, and anything else by its name. A
 * parameter that is absent or unreadable leaves the bare name. Null when the value has no type name.
 */
function typeSpelling(value: unknown): string | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  const name = value.type;
  const precision = numberField(value.precision);
  const scale = numberField(value.scale);
  const length = numberField(value.length);
  const wrap = (bare: string, inner: readonly string[] | null) =>
    inner === null ? bare : `${bare}(${inner.join(", ")})`;
  switch (name) {
    case "FIXED":
      return precision !== null && scale !== null ? `NUMBER(${precision},${scale})` : "NUMBER";
    case "REAL":
      return "FLOAT";
    case "DECFLOAT":
      return wrap(name, precision === null ? null : [String(precision)]);
    case "TEXT":
      return wrap("VARCHAR", length === null ? null : [String(length)]);
    case "BINARY":
      return wrap(name, length === null ? null : [String(length)]);
    case "OBJECT":
      return wrap(name, spelledFields(value.fields));
    case "ARRAY":
      return wrap(name, value.elementType === undefined ? null : spelledParts([value.elementType]));
    case "MAP":
      return wrap(name, value.keyType === undefined ? null : spelledParts([value.keyType, value.valueType]));
    case "VECTOR": {
      const element = typeSpelling(value.vectorElementType);
      const dimension = numberField(value.dimension);
      return wrap(name, element === null || dimension === null ? null : [element, String(dimension)]);
    }
  }
  return (name === "TIME" || name.startsWith("TIMESTAMP_")) && scale !== null ? `${name}(${scale})` : name;
}

/**
 * A `SHOW COLUMNS` row as a column: the `data_type` cell's JSON in the catalog spelling DESCRIBE TABLE answers for the
 * same column, which `typeSpelling` builds, so describe and the schema inventory read SHOW COLUMNS and still spell
 * every type as the catalog does.
 */
function columnOf(row: Row, primary: ReadonlySet<string>): ColumnSchema {
  const name = cellText(row.column_name);
  const parsed = parseCellJson(cellText(row.data_type), "data_type");
  const dataType = isObject(parsed) ? parsed : {};
  return {
    name,
    type: typeSpelling(dataType) ?? "",
    nullable: dataType.nullable === true,
    isPrimary: primary.has(name),
  };
}

/** An index's `columns` cell, `[A, B]`, as its column names. */
export function indexColumns(cell: SnowflakeCell | undefined): string[] {
  const list = cellText(cell).trim().replace(/^\[/, "").replace(/\]$/, "");
  return list === ""
    ? []
    : list.split(",").map((entry) => {
        const name = entry.trim();
        return name.length >= 2 && name.startsWith('"') && name.endsWith('"') ? unquoted(name) : name;
      });
}

/** The one row of a `SHOW ... LIKE` answer whose `name` is exactly `name`, or null. */
function exactRow(result: SnowflakeResult, name: string): Row | null {
  return result.rows.find((row) => row.name === name) ?? null;
}

function emptyDetail(path: readonly string[]): ObjectDetail {
  return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
}

/**
 * A table's or a view's columns from `SHOW COLUMNS`, a table's primary key from `SHOW PRIMARY KEYS`, and a hybrid
 * table's indexes, the only indexes Snowflake has. No documented source maps foreign keys, so there are none. Every
 * other declared kind has no columns and sends nothing.
 */
export async function describeObject(
  run: SnowflakeStatementRunner,
  path: readonly [string, string, string],
  kind: string,
): Promise<ObjectDetail> {
  kindRead(kind);
  const noun = COLUMN_KINDS[kind];
  if (noun === undefined) return emptyDetail(path);
  const tag = SNOWFLAKE_QUERY_TAGS.describe;
  const object = qualified(path);
  const columns = await run(`SHOW COLUMNS IN ${noun} ${object}`, tag);
  if (kind !== "table") return { ...emptyDetail(path), columns: columns.rows.map((row) => columnOf(row, new Set())) };
  const keys = await run(`SHOW PRIMARY KEYS IN TABLE ${object}`, tag);
  const primary = new Set(keys.rows.map((row) => cellText(row.column_name)));
  const catalog = await run(`SHOW TABLES LIKE ${literal(path[2])} ${inSchema([path[0], path[1]])}`, tag);
  const indexes: IndexSchema[] = [];
  if (cellFlag(exactRow(catalog, path[2])?.is_hybrid)) {
    const indexRows = await run(`SHOW INDEXES IN TABLE ${object}`, tag);
    for (const row of indexRows.rows) {
      indexes.push({ name: cellText(row.name), columns: indexColumns(row.columns), unique: cellFlag(row.is_unique) });
    }
  }
  return {
    path: [...path],
    columns: columns.rows.map((row) => columnOf(row, primary)),
    indexes,
    foreignKeys: [],
  };
}

// ============================================================================
// The inventory
// ============================================================================

/** One schema's `SHOW COLUMNS IN SCHEMA` answer, kept by the provider so a walk's tables and views share one read. */
export interface SchemaColumnsMemo {
  get(key: string): SnowflakeResult | undefined;
  set(key: string, result: SnowflakeResult): void;
}

/** Column rows grouped by the object they belong to, in the order they arrive. */
function groupColumns(rows: readonly Row[]): Map<string, ColumnSchema[]> {
  const grouped = new Map<string, ColumnSchema[]>();
  for (const row of rows) {
    const table = cellText(row.table_name);
    const columns = grouped.get(table) ?? [];
    columns.push(columnOf(row, new Set()));
    grouped.set(table, columns);
  }
  return grouped;
}

function listingStopReason(stop: ListingStop): string | null {
  if (stop === "pageLimit") return SNOWFLAKE_INTROSPECT_SENTENCES.treeCap;
  if (stop === "stalled") return SNOWFLAKE_INTROSPECT_SENTENCES.stalled;
  return null;
}

/**
 * Every table or view of one schema with its columns: the names from the kind's listing, bounded by the caller's
 * `limit` or `INVENTORY_LIMIT`, and the columns from one `SHOW COLUMNS IN SCHEMA`, shared through `memo`. Snowflake's
 * reference caps that read at 10,000 rows, so a full answer is replaced by one `SHOW COLUMNS` per listed object, at
 * most `INVENTORY_PAIR_LIMIT` of them. Every other kind answers no details and sends nothing.
 */
export async function describeObjects(
  run: SnowflakeStatementRunner,
  container: readonly [string, string],
  kind: string,
  limit: number | undefined,
  memo: SchemaColumnsMemo,
): Promise<ObjectDetailBatch> {
  kindRead(kind);
  const noun = COLUMN_KINDS[kind];
  if (noun === undefined) return { details: [] };
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
    throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.badLimit(limit));
  }
  const tag = SNOWFLAKE_QUERY_TAGS.inventory;
  const bound = limit ?? INVENTORY_LIMIT;
  // One row past the bound says whether the kind holds more.
  const pageLimit = Math.min(SNOWFLAKE_TREE_PAGE_LIMIT, Math.ceil((bound + 1) / SNOWFLAKE_SHOW_PAGE_ROWS));
  const listing = await readListing(run, container, kind, pageLimit, tag);
  const bounded = listing.objects.length > bound;
  let wanted = bounded ? listing.objects.slice(0, bound) : listing.objects;
  const reasons: string[] = [];
  let cutLimit: number | null = null;
  if (bounded) {
    reasons.push(limit === undefined ? INVENTORY_TRUNCATION_REASON : callerBoundTruncationReason(limit));
    cutLimit = bound;
  } else {
    const stopReason = listingStopReason(listing.stop);
    if (stopReason !== null) reasons.push(stopReason);
  }

  const key = JSON.stringify(container);
  let schemaColumns = memo.get(key);
  if (schemaColumns === undefined) {
    schemaColumns = await run(`SHOW COLUMNS ${inSchema(container)}`, tag);
    memo.set(key, schemaColumns);
  }
  let grouped: Map<string, ColumnSchema[]>;
  if (schemaColumns.rows.length < SNOWFLAKE_SHOW_PAGE_ROWS) {
    grouped = groupColumns(schemaColumns.rows);
  } else {
    if (wanted.length > INVENTORY_PAIR_LIMIT) {
      wanted = wanted.slice(0, INVENTORY_PAIR_LIMIT);
      reasons.push(SNOWFLAKE_INTROSPECT_SENTENCES.pairCap);
      cutLimit = INVENTORY_PAIR_LIMIT;
    }
    grouped = new Map();
    for (const object of wanted) {
      const name = object.path[2];
      // oxlint-disable-next-line no-await-in-loop -- one statement at a time holds one of the engine limiter's permits.
      const columns = await run(`SHOW COLUMNS IN ${noun} ${qualified([container[0], container[1], name])}`, tag);
      grouped.set(name, groupColumns(columns.rows).get(name) ?? []);
    }
  }

  const details: ObjectDetail[] = [];
  const missing: string[] = [];
  for (const object of wanted) {
    const columns = grouped.get(object.path[2]);
    if (columns === undefined || columns.length === 0) missing.push(object.path[2]);
    else details.push({ path: object.path, columns, indexes: [], foreignKeys: [] });
  }
  if (missing.length > 0) reasons.push(SNOWFLAKE_INTROSPECT_SENTENCES.noColumns(missing));
  if (reasons.length === 0) return { details };
  return { details, truncated: { limit: cutLimit ?? details.length, reason: reasons.join(", and ") } };
}

// ============================================================================
// Source
// ============================================================================

/** The `GET_DDL` object type of each kind read through it; a view is read from `SHOW VIEWS`, a stage has none. */
const DDL_TYPES: Readonly<Record<string, string>> = Object.freeze({
  table: "TABLE",
  stream: "STREAM",
  task: "TASK",
  sequence: "SEQUENCE",
  "file-format": "FILE_FORMAT",
  pipe: "PIPE",
  function: "FUNCTION",
  procedure: "PROCEDURE",
});

const SOURCE_PART_ID = "definition";

/** A routine segment `F(NUMBER, VARCHAR)` as its quoted name and its argument types: `"F"(NUMBER, VARCHAR)`. */
function routineObject(segment: string): string {
  const open = argumentListStart(segment);
  return open === -1 ? quoteIdent(segment) : `${quoteIdent(segment.slice(0, open))}${segment.slice(open)}`;
}

/** Where the balanced argument group that closes `segment` opens, or -1 when it does not end in one. */
function argumentListStart(segment: string): number {
  if (!segment.endsWith(")")) return -1;
  let depth = 0;
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    if (segment[index] === ")") depth += 1;
    else if (segment[index] === "(") depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function definition(
  path: readonly [string, string, string],
  kind: string,
  value: string,
  origin: "stored" | "regenerated",
  limit: number | undefined,
): ObjectSourceDocument {
  if (value.trim() === "") throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.noDefinition(path[2]));
  const bounded = applySourceBound(value, limit);
  return {
    path: [...path],
    kind,
    parts: [
      {
        id: SOURCE_PART_ID,
        label: SNOWFLAKE_INTROSPECT_SENTENCES.sourceLabel,
        text: bounded.text,
        language: "sql",
        form: "complete",
        origin,
        ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
      },
    ],
  };
}

/**
 * One object's definition: a view's text from `SHOW VIEWS LIKE`, which needs no warehouse, and every other kind's
 * through `SELECT GET_DDL(...)`, the one statement here that is not a `SHOW`, sent only on the user's open. A secure
 * view the role does not own answers an empty text, which is the refusal sentence, never an empty definition.
 */
export async function readObjectSource(
  run: SnowflakeStatementRunner,
  path: readonly [string, string, string],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  kindRead(kind);
  const tag = SNOWFLAKE_QUERY_TAGS.source;
  if (kind === "view") {
    const answer = await run(`SHOW VIEWS LIKE ${literal(path[2])} ${inSchema([path[0], path[1]])}`, tag);
    const row = exactRow(answer, path[2]);
    if (row === null) throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.notShown(path[2]));
    const viewText = cellText(row.text);
    if (viewText.trim() === "" && cellFlag(row.is_secure)) {
      return {
        path: [...path],
        kind,
        parts: [
          {
            id: SOURCE_PART_ID,
            label: SNOWFLAKE_INTROSPECT_SENTENCES.sourceLabel,
            unavailable: SNOWFLAKE_INTROSPECT_SENTENCES.secureView,
          },
        ],
      };
    }
    return definition(path, kind, viewText, "stored", limit);
  }
  const ddlType = DDL_TYPES[kind];
  if (ddlType === undefined) throw new SnowflakeError("query", SNOWFLAKE_INTROSPECT_SENTENCES.noSource(kind));
  const object = ROUTINE_KINDS.has(kind) ? routineObject(path[2]) : quoteIdent(path[2]);
  const name = `${quoteIdent(path[0])}.${quoteIdent(path[1])}.${object}`;
  const answer = await run(`SELECT GET_DDL(${literal(ddlType)}, ${literal(name)})`, tag);
  const field = answer.fields[0];
  return definition(path, kind, field === undefined ? "" : cellText(answer.rows[0]?.[field]), "regenerated", limit);
}

// ============================================================================
// Health
// ============================================================================

/**
 * The connect statement, tagged health, which proves the role and the warehouse's visibility without a running
 * warehouse. Snowflake publishes no connection count, size or cache ratio here, so the count stays absent.
 */
export async function getHealth(run: SnowflakeStatementRunner, warehouse: string | undefined): Promise<HealthInfo> {
  await run(connectStatement(warehouse), SNOWFLAKE_QUERY_TAGS.health);
  return { databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] };
}
