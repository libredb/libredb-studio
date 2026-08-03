/**
 * ClickHouse schema introspection (issue #264, design spec section 3.6)
 *
 * Three reads of the `system.*` catalogs, all through the transport seam so this
 * file stays free of any wire vocabulary:
 *
 * - `system.tables` -> the table list, its row counts and sizes, and the two
 *   keys a MergeTree sorts by.
 * - `system.columns` -> columns in declaration order, with the declared type
 *   string, primary-key membership and the column default.
 * - `system.data_skipping_indices` -> the nearest thing ClickHouse has to a
 *   secondary index.
 *
 * Foreign keys are absent everywhere by construction: ClickHouse has none - no
 * engine, no table setting and no DDL declares one - so an empty list here is a
 * fact about the engine, not a load that failed or was deferred.
 *
 * Five things the live server (26.7.1.1315) forced, each load-bearing:
 *
 * 1. `total_rows`/`total_bytes` are `Nullable(UInt64)` and really are null for a
 *    view and for every non-MergeTree engine. Null is UNKNOWN, never zero.
 * 2. A `UInt64` arrives as a decimal STRING because the transport always sends
 *    64-bit quoting (spec 2.1), while a `UInt8` such as `is_in_primary_key`
 *    stays an unquoted number. Both encodings are accepted.
 * 3. A key expression is a comma-separated list that can itself contain commas -
 *    `a, b, cityHash64(c, c)` - and a one-element key keeps the parentheses a
 *    multi-element one drops: `(a)` versus `a, b`. Splitting has to be
 *    parenthesis-aware or a column ends up named `(a)` or `cityHash64(c`.
 * 4. `Nullable` is not always the outermost wrapper, and is not always the
 *    column's own: `LowCardinality(Nullable(String))` is nullable while
 *    `Array(Nullable(String))` is not.
 * 5. `system.tables` and `system.columns` are pre-filtered to what the user may
 *    read, but `system.data_skipping_indices` needs its own grant and answers
 *    500 / code 497 without it. Each catalog therefore degrades on its own.
 */

import type { ColumnSchema, IndexSchema, TableRelations, TableSchema } from "@/lib/types";
import { formatBytes } from "../../../utils/pool-manager";
import { type ClickHouseRow, type ClickHouseTransport, ClickHouseTransportError } from "./transport";

// ============================================================================
// Constants
// ============================================================================

/**
 * Databases holding the server's own bookkeeping rather than a user's data.
 *
 * `information_schema` exists twice, once in each case, and both are real
 * separate entries in `system.databases` (live-verified) - excluding one leaves
 * a duplicate of every ANSI catalog view in the tree. `default` is deliberately
 * NOT here: it is an ordinary writable database, and it is where a connection
 * that names none lands, so hiding it would empty the commonest setup.
 *
 * Exported because the monitoring reads (spec 3.7) filter `system.parts` by the
 * same rule, and one definition is the point.
 */
export const CLICKHOUSE_SYSTEM_DATABASES: readonly string[] = Object.freeze([
  "system",
  "information_schema",
  "INFORMATION_SCHEMA",
]);

/**
 * Name for the synthesized primary-key index.
 *
 * ClickHouse does not name its primary index - it is part of the table, not a
 * separate object - so this is the wording `SHOW CREATE TABLE` uses, which is
 * what a ClickHouse user already reads.
 */
export const CLICKHOUSE_PRIMARY_INDEX_NAME = "PRIMARY KEY";

/** Name for the sorting key, reported only when it extends the primary key. */
export const CLICKHOUSE_SORTING_INDEX_NAME = "ORDER BY";

/**
 * Server-side deadline for a catalog read, in seconds (`max_execution_time`'s
 * unit). A cluster with thousands of tables or one stuck replica must not leave
 * the schema tree spinning with no way out.
 */
export const CLICKHOUSE_CATALOG_TIMEOUT_SECONDS = 15;

/** Names are compile-time constants, so inlining them as literals is safe. */
const NON_SYSTEM_DATABASE = `database NOT IN (${CLICKHOUSE_SYSTEM_DATABASES.map((name) => `'${name}'`).join(", ")})`;

const TABLE_LIST_SQL = [
  "SELECT database, name, total_rows, total_bytes, sorting_key, primary_key",
  "FROM system.tables",
  `WHERE ${NON_SYSTEM_DATABASE}`,
  "ORDER BY database, name",
].join(" ");

/** `position` orders the projection rather than appearing in it: it IS the declared column order. */
const COLUMN_LIST_SQL = [
  "SELECT database, table, name, type, is_in_primary_key, default_kind, default_expression",
  "FROM system.columns",
  `WHERE ${NON_SYSTEM_DATABASE}`,
  "ORDER BY database, table, position",
].join(" ");

/**
 * The database filter is not an optimisation here. Live-verified: the system
 * databases contribute around forty rows of their own, which swamp a user's
 * handful of indexes when the predicate is left off.
 */
const INDEX_LIST_SQL = [
  "SELECT database, table, name, expr",
  "FROM system.data_skipping_indices",
  `WHERE ${NON_SYSTEM_DATABASE}`,
  "ORDER BY database, table, name",
].join(" ");

/** The one wrapper ClickHouse puts outside `Nullable` instead of inside it. */
const LOW_CARDINALITY_PREFIX = "LowCardinality(";

const NULLABLE_PREFIX = "Nullable(";

/** The only `default_kind` that is an insert-time default rather than a computed column. */
const DEFAULT_KIND = "DEFAULT";

/**
 * Separator joining a database to a table in the grouping key. NUL rather than a
 * dot because a dot is ambiguous - a quoted database or table name may contain
 * one, so `"a.b" + "c"` and `"a" + "b.c"` would land in the same bucket.
 */
const KEY_SEPARATOR = "\u0000";

// ============================================================================
// Types
// ============================================================================

/** One `system.tables` row, decoded. */
interface TableInfo {
  database: string;
  name: string;
  /** Undefined when the server reported null - unknown, not zero. */
  rowCount: number | undefined;
  sizeBytes: number | undefined;
  primaryKey: string[];
  sortingKey: string[];
}

/** A catalog row placed against the table that owns it. */
interface OwnedEntry<T> {
  key: string;
  value: T;
}

// ============================================================================
// Value readers
// ============================================================================

/** An identifier, or null for a row that cannot be placed and must be skipped. */
function readIdentifier(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A `Nullable(UInt64)` count.
 *
 * Both encodings are real: the transport sends 64-bit quoting so nothing rounds
 * through `JSON.parse` (spec 2.1), which turns a `UInt64` into a decimal string,
 * while a source without that setting would send a number. Anything else -
 * null, an empty string, prose - is UNKNOWN and must stay undefined: a table
 * shown as "0 rows" when the server never said so is a number the explorer
 * invented, and a view reports null for exactly this field.
 */
function readCount(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return value.length > 0 && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether the COLUMN accepts null, which is not the same as the type mentioning
 * `Nullable`. Live-verified: `Array(Nullable(String))`,
 * `Map(String, Nullable(String))` and `SimpleAggregateFunction(any,
 * Nullable(UInt64))` all qualify an inner type, so a substring search calls
 * three non-nullable columns nullable; `LowCardinality(Nullable(String))` is the
 * one combination spelled the other way round, so a bare prefix test misses it.
 */
function isNullableType(type: string): boolean {
  const inner = type.startsWith(LOW_CARDINALITY_PREFIX) ? type.slice(LOW_CARDINALITY_PREFIX.length) : type;
  return inner.startsWith(NULLABLE_PREFIX);
}

/**
 * The column default as the explorer should show it.
 *
 * Live-verified kinds are `DEFAULT`, `MATERIALIZED` and `ALIAS`. Only the first
 * is a default an INSERT may override; the other two are computed columns, and
 * printing their expression bare would read as a value the user could supply.
 */
function readDefault(kind: string, expression: string): string | undefined {
  if (kind === "" || expression === "") return undefined;
  return kind === DEFAULT_KIND ? expression : `${kind} ${expression}`;
}

// ============================================================================
// Key expressions
// ============================================================================

/**
 * Drop one pair of parentheses when it wraps the whole expression.
 *
 * Live-verified rendering: a one-element key comes back as `(a)` while a
 * multi-element one comes back as `a, b`, and a data-skipping index over an
 * expression comes back as `(lower(b))`. The depth walk is what refuses
 * `(a), (b)`, where the first parenthesis closes long before the end.
 */
/** The quote characters ClickHouse opens a span with: identifiers, then literals. */
const QUOTES = new Set(["`", '"', "'"]);

/**
 * The index just past the quoted span opening at `open`.
 *
 * Needed because a quoted span may legally contain the very characters the scans
 * below treat as syntax: `` `region,code` `` is one identifier, and `` `a(b` ``
 * contains a parenthesis that must not move the depth counter. Both a backslash and
 * a doubled quote escape the quote rather than closing it. An unterminated span
 * consumes the rest of the string, which is the reading that cannot mis-split.
 */
function endOfQuoted(text: string, open: number): number {
  const quote = text[open];
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 1;
        continue;
      }
      return index + 1;
    }
  }
  return text.length;
}

function unwrapOuterParens(expression: string): string {
  if (!expression.startsWith("(") || !expression.endsWith(")")) return expression;

  let depth = 0;
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (QUOTES.has(char)) {
      index = endOfQuoted(expression, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0 && index < expression.length - 1) return expression;
    }
    index += 1;
  }
  return expression.slice(1, -1).trim();
}

/**
 * Split a key or index expression into the elements it lists.
 *
 * Splitting on every comma is the trap: live-verified keys include
 * `a, b, cityHash64(c, c)` and `a, concat(b, 'x, y')`, both of which carry
 * commas that belong to a nested call, so only a top-level comma separates two
 * elements. Every comma that matters is outside every parenthesis, which is why
 * depth alone is enough and no lexer is needed.
 */
function splitKeyExpression(expression: string): string[] {
  const listed = unwrapOuterParens(expression.trim());
  if (listed === "") return [];

  const elements: string[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < listed.length) {
    const char = listed[index];
    if (QUOTES.has(char)) {
      index = endOfQuoted(listed, index);
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      elements.push(listed.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }
  elements.push(listed.slice(start).trim());
  return elements.filter((element) => element !== "");
}

// ============================================================================
// Row decoding
// ============================================================================

function tableKey(database: string, table: string): string {
  return `${database}${KEY_SEPARATOR}${table}`;
}

function readTableInfo(row: ClickHouseRow): TableInfo | null {
  const database = readIdentifier(row.database);
  const name = readIdentifier(row.name);
  if (database === null || name === null) return null;

  return {
    database,
    name,
    rowCount: readCount(row.total_rows),
    sizeBytes: readCount(row.total_bytes),
    primaryKey: splitKeyExpression(readText(row.primary_key)),
    sortingKey: splitKeyExpression(readText(row.sorting_key)),
  };
}

function readColumn(row: ClickHouseRow): OwnedEntry<ColumnSchema> | null {
  const database = readIdentifier(row.database);
  const table = readIdentifier(row.table);
  const name = readIdentifier(row.name);
  if (database === null || table === null || name === null) return null;

  // Spec 1.7: the declared type goes through verbatim. Collapsing it onto a
  // generic family would throw away the wrapper, and the wrapper is the part
  // that says nullable, low-cardinality, parameterised or enumerated.
  const type = readText(row.type);

  return {
    key: tableKey(database, table),
    value: {
      name,
      type,
      nullable: isNullableType(type),
      // `is_in_primary_key` is the authority: the sorting key may extend past
      // the primary key, and those trailing columns are not primary.
      isPrimary: row.is_in_primary_key === 1,
      defaultValue: readDefault(readText(row.default_kind), readText(row.default_expression)),
    },
  };
}

function readIndex(row: ClickHouseRow): OwnedEntry<IndexSchema> | null {
  const database = readIdentifier(row.database);
  const table = readIdentifier(row.table);
  const name = readIdentifier(row.name);
  if (database === null || table === null || name === null) return null;

  return {
    key: tableKey(database, table),
    // A data-skipping index prunes granules and enforces nothing, so no index
    // ClickHouse reports is unique. Nor is the primary key: live-verified, three
    // identical values were accepted into a table declared PRIMARY KEY (a).
    value: { name, columns: splitKeyExpression(readText(row.expr)), unique: false },
  };
}

/**
 * Bucket rows by the table that owns them. A row the decoder cannot place is
 * dropped rather than fatal, so one malformed row costs one entry instead of
 * the whole tree.
 */
function groupByTable<T>(
  rows: ClickHouseRow[],
  decode: (row: ClickHouseRow) => OwnedEntry<T> | null,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const entry = decode(row);
    if (entry === null) continue;
    const owned = grouped.get(entry.key) ?? [];
    owned.push(entry.value);
    grouped.set(entry.key, owned);
  }
  return grouped;
}

// ============================================================================
// Catalog reads
// ============================================================================

/**
 * One catalog read, degrading to no rows when the catalog is not available.
 *
 * `ACCESS_DENIED` and `UNKNOWN_TABLE` are the two codes that mean "this surface
 * does not exist for this user or this deployment", and both are ordinary rather
 * than broken - live-verified, a user granted SELECT on a single table reads
 * `system.tables` and `system.columns` happily but gets 497 from
 * `system.data_skipping_indices`, which needs its own grant. Losing the whole
 * schema tree over that would punish a perfectly usable connection. Every other
 * failure propagates: an empty tree in place of a real error hides it forever.
 */
async function readCatalog(transport: ClickHouseTransport, sql: string): Promise<ClickHouseRow[]> {
  try {
    const settings = { max_execution_time: CLICKHOUSE_CATALOG_TIMEOUT_SECONDS };
    const result = await transport.query(sql, { settings });
    return result.rows;
  } catch (error) {
    if (error instanceof ClickHouseTransportError && error.isMonitoringUnavailable()) return [];
    throw error;
  }
}

async function readTables(transport: ClickHouseTransport): Promise<TableInfo[]> {
  const rows = await readCatalog(transport, TABLE_LIST_SQL);
  return rows.map(readTableInfo).filter((table): table is TableInfo => table !== null);
}

async function readColumns(transport: ClickHouseTransport): Promise<Map<string, ColumnSchema[]>> {
  return groupByTable(await readCatalog(transport, COLUMN_LIST_SQL), readColumn);
}

async function readIndexes(transport: ClickHouseTransport): Promise<Map<string, IndexSchema[]>> {
  return groupByTable(await readCatalog(transport, INDEX_LIST_SQL), readIndex);
}

// ============================================================================
// Assembly
// ============================================================================

/**
 * The name the flat schema explorer shows, and the name the generated SQL uses.
 *
 * A bare name resolves against the database the connection pinned, so
 * qualifying a table inside it would be noise; a table outside it must be
 * qualified or the generated statement reads the wrong database. Same rule
 * `postgres.ts` applies to `public`.
 */
function displayName(table: TableInfo, pinnedDatabase: string): string {
  return table.database === pinnedDatabase ? table.name : `${table.database}.${table.name}`;
}

function sameColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

/**
 * The primary key, plus the sorting key when it says something the primary key
 * does not.
 *
 * ClickHouse's primary key is a real sparse index over the sort order, so a
 * MergeTree table reporting no index at all would be misleading. `ORDER BY` may
 * extend `PRIMARY KEY`, and the trailing columns genuinely shape the on-disk
 * order and the query plan, so they are reported as their own entry - comparing
 * the split element lists rather than the raw strings, because the server
 * renders the same one-element key as `(a)` in one column and `a` in the other.
 */
function keyIndexes(table: TableInfo): IndexSchema[] {
  const indexes: IndexSchema[] = [];
  if (table.primaryKey.length > 0) {
    indexes.push({ name: CLICKHOUSE_PRIMARY_INDEX_NAME, columns: table.primaryKey, unique: false });
  }
  if (table.sortingKey.length > 0 && !sameColumns(table.primaryKey, table.sortingKey)) {
    indexes.push({ name: CLICKHOUSE_SORTING_INDEX_NAME, columns: table.sortingKey, unique: false });
  }
  return indexes;
}

function tableIndexes(table: TableInfo, indexes: Map<string, IndexSchema[]>): IndexSchema[] {
  return [...keyIndexes(table), ...(indexes.get(tableKey(table.database, table.name)) ?? [])];
}

function toTableSchema(
  table: TableInfo,
  pinnedDatabase: string,
  columns: ColumnSchema[],
  indexes: IndexSchema[],
): TableSchema {
  return {
    name: displayName(table, pinnedDatabase),
    columns,
    indexes,
    foreignKeys: [],
    rowCount: table.rowCount,
    size: table.sizeBytes === undefined ? undefined : formatBytes(table.sizeBytes),
  };
}

// ============================================================================
// Introspection
// ============================================================================

/** Every table of every non-system database, with its columns and indexes. */
export async function getSchema(transport: ClickHouseTransport, pinnedDatabase: string): Promise<TableSchema[]> {
  const [tables, columns, indexes] = await Promise.all([
    readTables(transport),
    readColumns(transport),
    readIndexes(transport),
  ]);

  return tables.map((table) => {
    const owned = columns.get(tableKey(table.database, table.name)) ?? [];
    return toTableSchema(table, pinnedDatabase, owned, tableIndexes(table, indexes));
  });
}

/**
 * Fast structural schema: tables and columns only. Indexes are left to
 * `getSchemaRelations()` so a third catalog read never blocks the table list,
 * exactly as in the SQL providers.
 */
export async function getSchemaList(transport: ClickHouseTransport, pinnedDatabase: string): Promise<TableSchema[]> {
  const [tables, columns] = await Promise.all([readTables(transport), readColumns(transport)]);

  return tables.map((table) => {
    const owned = columns.get(tableKey(table.database, table.name)) ?? [];
    return toTableSchema(table, pinnedDatabase, owned, []);
  });
}

/**
 * Index lists keyed by the same display name `getSchemaList()` produced, so the
 * client can merge them in.
 *
 * An entry is returned for every table, not only for the ones carrying an index:
 * an empty list is the honest statement that the table has none, and omitting
 * the table would instead leave whatever the client already had on screen.
 */
export async function getSchemaRelations(
  transport: ClickHouseTransport,
  pinnedDatabase: string,
): Promise<TableRelations[]> {
  const [tables, indexes] = await Promise.all([readTables(transport), readIndexes(transport)]);

  return tables.map((table) => ({
    name: displayName(table, pinnedDatabase),
    foreignKeys: [],
    indexes: tableIndexes(table, indexes),
  }));
}
