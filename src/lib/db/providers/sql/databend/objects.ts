/**
 * The Databend object surface (design 5.4): the statements, the row mappers and the reads behind the connect
 * cautions, `listContainers`, `countObjects`, `listObjects`, `describeObject`, `describeObjects` and
 * `readObjectSource`.
 *
 * Every read is a provider statement handed to a {@link DatabendStatementRunner} the provider passes in, so this file
 * names no request, page or socket, and its rows are read through `decode.ts` like any other answer. Names reach a
 * statement only through `quoteIdentifier` and `quoteLiteral` under `"databend"`: a backtick identifier with the
 * backtick doubled, and a literal with the quote and the backslash doubled, since Databend's string escapes include
 * the backslash (design 5.1).
 *
 * Measured facts the statements rest on:
 *
 * - `system.tables` reports exactly four `table_type` spellings (`tables_table.rs:1114-1124`); a materialized view is
 *   `MATERIALIZED VIEW`, not `BASE TABLE` (L6). The count's ELSE arm keeps any other spelling as `unknown:<type>`,
 *   which is raised by name rather than dropped.
 * - `num_rows` is NULL, not 0, for a view or an object without statistics, so it stays undefined.
 * - `system.columns` answers each object's rows contiguously and in declared order, through the semi-join too (L1,
 *   L2), so `describeObjects` keeps the one-statement form [X19] and groups its rows in the order they arrive.
 * - `system.columns` answers no rows, silently, for a view that no longer plans (its base table dropped), so the
 *   object reads take their names from `system.tables` and never hand such a view over as complete with no columns.
 * - A materialized view's `system.columns` rows include its internal `_mv_source_row_id`, which `SELECT *` does not
 *   show and a select of it refuses with 1065, so it is left out for that kind only: a table may own a column so named.
 * - `SHOW CREATE TABLE ... WITH QUOTED_IDENTIFIERS` quotes every name, so the DDL re-runs, and refuses a materialized
 *   view with 1302, which `SHOW CREATE MATERIALIZED VIEW` reads instead (L6).
 *
 * A statement budget cut (design 3.12) is never handed over as complete [X05]: `describeObjects` drops the partly
 * read last object and says so in `truncated`, and every other read refuses with a sentence naming the bound,
 * `readObjectSource` among them, since the budget never cuts a definition's one row but only keeps or drops it.
 */
import { QueryError } from "@/lib/db/errors";
import { applySourceBound, callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectSourceDocument,
} from "@/lib/db/types";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { quoteLiteral } from "@/lib/sql/values";
import type { ColumnSchema, IndexSchema } from "@/lib/types";
import { decodeOutcome } from "./decode";
import { serverWords } from "./errors";
import { DatabendError, type DatabendTruncation, type StatementOutcome } from "./transport";

const PROVIDER = "databend";

/**
 * Runs one provider statement to its end: the statement and the row cut in, the completed outcome out. The provider
 * supplies it, with its deadline, permits and session settings already folded in.
 */
export type DatabendStatementRunner = (sql: string, rowCut: number) => Promise<StatementOutcome>;

/** The row cut every surface statement is sent with: the statement budget's own (design 3.12). */
export const DATABEND_SURFACE_ROW_CUT = MAX_UNLIMITED_ROWS;

/** The catalog Databend opens a session in, and the only one `system.indexes` describes. */
export const DATABEND_DEFAULT_CATALOG = "default";

/** One database inside one catalog, the container every object read addresses. */
export interface DatabendContainer {
  readonly catalog: string;
  readonly database: string;
}

/** Each object kind and the `system.tables.table_type` spelling it is read from. */
const TABLE_TYPES: Readonly<Record<string, string>> = {
  table: "BASE TABLE",
  view: "VIEW",
  materialized_view: "MATERIALIZED VIEW",
  dynamic_table: "DYNAMIC TABLE",
};

/** The object kinds this surface reads, in declaration order. */
const DATABEND_OBJECT_KINDS = Object.freeze(Object.keys(TABLE_TYPES));

/** The kind read through `SHOW CREATE MATERIALIZED VIEW`; every other kind is read through `SHOW CREATE TABLE`. */
const MATERIALIZED_VIEW_KIND = "materialized_view";

/** The prefix the count's ELSE arm puts before a spelling no kind is read from. */
const UNKNOWN_KIND_PREFIX = "unknown:";

/** A materialized view's internal column, which no statement can select (`MATERIALIZED_VIEW_SOURCE_ROW_ID_COLUMN`). */
const MATERIALIZED_VIEW_INTERNAL_COLUMN = "_mv_source_row_id";

/** The column both `SHOW CREATE` statements answer the DDL in (L6). */
const SOURCE_COLUMN = "Create Table";

/** The one part a definition document holds. */
const DATABEND_SOURCE_PART_ID = "definition";

/** Databend's code for a statement the user's grants do not cover (`PermissionDenied`, `exception_code.rs`). */
const PERMISSION_DENIED_CODE = 1063;

const BOUND_UNITS: Readonly<Record<DatabendTruncation["bound"], string>> = {
  rows: "rows",
  cells: "cells",
  bytes: "bytes of answer text",
};

/** Every sentence this surface shows. */
export const DATABEND_OBJECT_SENTENCES = Object.freeze({
  bound: (cut: DatabendTruncation) => `${cut.limit.toLocaleString("en-US")} ${BOUND_UNITS[cut.bound]}`,
  incomplete: (surface: string, cut: DatabendTruncation) =>
    `Databend's answer to the ${surface} reached Studio's statement budget of ${DATABEND_OBJECT_SENTENCES.bound(cut)}, so Studio shows none of it rather than part of it.`,
  bulkCut: (cut: DatabendTruncation) =>
    `the bulk column read stopped at Studio's statement budget of ${DATABEND_OBJECT_SENTENCES.bound(cut)}, so the object it was reading was left out`,
  unknownTableType: (spelling: string) =>
    `Databend reported an object of table_type "${spelling}", which Studio has no object kind for.`,
  unknownKind: (kind: string) => `Databend has no object kind "${kind}" in Studio.`,
  badLimit: (limit: number) => `A Databend bulk column read limit must be a positive whole number, received ${limit}.`,
  noColumns: (object: string) =>
    `Databend lists no columns for "${object}", as it does for a view that no longer plans, so Studio shows no column list rather than an empty one.`,
  noColumnsLeftOut: (objects: readonly string[]) =>
    `Databend listed no columns for ${objects.map((name) => `"${name}"`).join(", ")}, as it does for a view that no longer plans, so ${objects.length === 1 ? "it was" : "they were"} left out`,
  noDefinition: (object: string) => `Databend answered no definition for "${object}".`,
  noPassword: (user: string) =>
    `The user "${user}" is created with no_password, so the server accepts any password for it.`,
  sourceLabel: "Definition",
});

// ============================================================================
// Statements
// ============================================================================

function ident(name: string): string {
  return quoteIdentifier(name, PROVIDER);
}

function literal(value: string): string {
  return quoteLiteral(value, PROVIDER);
}

/** The `table_type` spelling of one kind, or a refusal naming the kind. */
function tableTypeOf(kind: string): string {
  const spelling = TABLE_TYPES[kind];
  if (spelling === undefined) throw new QueryError(DATABEND_OBJECT_SENTENCES.unknownKind(kind), PROVIDER);
  return spelling;
}

/** One container's `system.tables` rows: the catalog-qualified table, filtered by both segments. */
function tablesIn(container: DatabendContainer): string {
  return `FROM ${ident(container.catalog)}.system.tables WHERE catalog = ${literal(container.catalog)} AND database = ${literal(container.database)}`;
}

/** The connect probe; the role is its answer's `session.role`, which the transport reads. */
export const DATABEND_VERSION_SQL = "SELECT version() AS server_version";

/** The best-effort read behind the `no_password` caution [X12]: `system.users` needs no grant for one's own row (UC2). */
function databendAuthTypeSql(user: string): string {
  return `SELECT auth_type FROM default.system.users WHERE name = ${literal(user)}`;
}

const DATABEND_CATALOG_LIST_SQL = "SELECT name AS catalog_name FROM system.catalogs ORDER BY name";

/** One catalog's databases, without the two every catalog generates. */
function databendDatabaseListSql(catalog: string): string {
  return `SELECT name AS database_name FROM ${ident(catalog)}.system.databases WHERE catalog = ${literal(catalog)} AND name NOT IN ('system', 'information_schema') ORDER BY name`;
}

/** Every kind's count in one statement; projecting only `table_type` keeps the statistics off. */
function databendObjectCountsSql(container: DatabendContainer): string {
  const arms = Object.entries(TABLE_TYPES).map(([kind, spelling]) => `WHEN ${literal(spelling)} THEN ${literal(kind)}`);
  return `SELECT kind, count(*) AS object_count FROM (SELECT CASE table_type ${arms.join(" ")} ELSE concat('${UNKNOWN_KIND_PREFIX}', table_type) END AS kind ${tablesIn(container)}) AS objects GROUP BY kind`;
}

function databendObjectListSql(container: DatabendContainer, kind: string): string {
  return `SELECT name AS object_name, num_rows, data_compressed_size, comment ${tablesIn(container)} AND table_type = ${literal(tableTypeOf(kind))} ORDER BY name`;
}

/** The filter that leaves a materialized view's internal column out, and nothing for any other kind. */
function internalColumnFilter(kind: string): string {
  return kind === MATERIALIZED_VIEW_KIND ? ` AND name <> ${literal(MATERIALIZED_VIEW_INTERNAL_COLUMN)}` : "";
}

/** One object's columns; no ORDER BY, since the rows come in declared order (L1). */
function databendColumnsSql(container: DatabendContainer, kind: string, object: string): string {
  return `SELECT name AS column_name, data_type, is_nullable, default_kind, default_expression, comment FROM ${ident(container.catalog)}.system.columns WHERE database = ${literal(container.database)} AND \`table\` = ${literal(object)}${internalColumnFilter(kind)}`;
}

/** One object's search indexes, which `default.system.indexes` holds for the default catalog only. */
function databendIndexesSql(database: string, object: string): string {
  return `SELECT name AS index_name, \`type\` AS index_type, definition FROM default.system.indexes WHERE database = ${literal(database)} AND \`table\` = ${literal(object)} ORDER BY name`;
}

/**
 * Every object's columns for one kind in one statement [03 7.1], bounded by `bound` objects in name order when given.
 * The bound is interpolated: the caller's value is a checked positive whole number.
 */
function databendBulkColumnsSql(container: DatabendContainer, kind: string, bound?: number): string {
  const order = bound === undefined ? "" : ` ORDER BY name LIMIT ${bound}`;
  return `SELECT \`table\` AS object_name, name AS column_name, data_type, is_nullable, default_kind, default_expression FROM ${ident(container.catalog)}.system.columns WHERE database = ${literal(container.database)}${internalColumnFilter(kind)} AND \`table\` IN (SELECT name ${tablesIn(container)} AND table_type = ${literal(tableTypeOf(kind))}${order})`;
}

/** The names the bulk column read must describe, in its subquery's order and bound. */
function databendObjectNamesSql(container: DatabendContainer, kind: string, bound?: number): string {
  const cap = bound === undefined ? "" : ` LIMIT ${bound}`;
  return `SELECT name AS object_name ${tablesIn(container)} AND table_type = ${literal(tableTypeOf(kind))} ORDER BY name${cap}`;
}

function databendSourceSql(container: DatabendContainer, kind: string, object: string): string {
  tableTypeOf(kind);
  const name = `${ident(container.catalog)}.${ident(container.database)}.${ident(object)}`;
  return kind === MATERIALIZED_VIEW_KIND
    ? `SHOW CREATE MATERIALIZED VIEW ${name}`
    : `SHOW CREATE TABLE ${name} WITH QUOTED_IDENTIFIERS`;
}

// ============================================================================
// Reads
// ============================================================================

function readText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * A count or size the engine reported, or undefined for a NULL; one past 2^53 arrives as its text and reads as its
 * nearest number, so not exact.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  return typeof value === "string" ? Number(value) : undefined;
}

/** One statement's rows, decoded, or a refusal naming the bound when a budget cut it short. */
async function readRows(
  runner: DatabendStatementRunner,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: DatabendTruncation | null }> {
  const outcome = await runner(sql, DATABEND_SURFACE_ROW_CUT);
  return { rows: decodeOutcome(outcome, sql).rows, truncated: outcome.truncated };
}

/**
 * One statement's rows, which must be whole: the answers that carry no `truncated` field refuse a cut one, naming
 * `surface` and the bound [X05].
 */
export async function readCompleteRows(
  runner: DatabendStatementRunner,
  sql: string,
  surface: string,
): Promise<Record<string, unknown>[]> {
  const { rows, truncated } = await readRows(runner, sql);
  if (truncated !== null) throw new QueryError(DATABEND_OBJECT_SENTENCES.incomplete(surface, truncated), PROVIDER, sql);
  return rows;
}

/**
 * The `no_password` caution of design 6.4, or null. Best effort by design [X12]: any failure of the read is no
 * caution, never a failed connect.
 */
export async function readNoPasswordCaution(runner: DatabendStatementRunner, user: string): Promise<string | null> {
  try {
    const { rows } = await readRows(runner, databendAuthTypeSql(user));
    return rows[0]?.auth_type === "no_password" ? DATABEND_OBJECT_SENTENCES.noPassword(user) : null;
  } catch {
    return null;
  }
}

export async function listCatalogs(runner: DatabendStatementRunner): Promise<Container[]> {
  const rows = await readCompleteRows(runner, DATABEND_CATALOG_LIST_SQL, "catalog list");
  return rows.map((row) => {
    const name = readText(row.catalog_name);
    return { path: [name], name, level: 0, isSessionDefault: name === DATABEND_DEFAULT_CATALOG };
  });
}

/** One catalog's databases; `sessionDatabase` is the connection's own, marked as the session default. */
export async function listDatabases(
  runner: DatabendStatementRunner,
  catalog: string,
  sessionDatabase?: string,
): Promise<Container[]> {
  const rows = await readCompleteRows(runner, databendDatabaseListSql(catalog), "database list");
  return rows.map((row) => {
    const name = readText(row.database_name);
    return { path: [catalog, name], name, level: 1, isSessionDefault: name === sessionDatabase };
  });
}

/** Every kind's count; a `table_type` Studio has no kind for is raised by name, through `serverWords` (design 3.13). */
export async function countObjects(
  runner: DatabendStatementRunner,
  container: DatabendContainer,
  secretForms: readonly string[],
): Promise<Record<string, KindCount>> {
  const counts: Record<string, KindCount> = Object.fromEntries(
    DATABEND_OBJECT_KINDS.map((kind) => [kind, { count: 0 }]),
  );
  const rows = await readCompleteRows(runner, databendObjectCountsSql(container), "object count");
  for (const row of rows) {
    const kind = readText(row.kind);
    if (!(kind in TABLE_TYPES)) {
      const spelling = kind.startsWith(UNKNOWN_KIND_PREFIX) ? kind.slice(UNKNOWN_KIND_PREFIX.length) : kind;
      throw new QueryError(DATABEND_OBJECT_SENTENCES.unknownTableType(serverWords(spelling, secretForms)), PROVIDER);
    }
    counts[kind] = { count: readNumber(row.object_count) ?? 0 };
  }
  return counts;
}

/**
 * The kinds whose `system.tables` counts are not theirs: a materialized view's row there says 0 rows and 0 bytes
 * whatever it holds (measured on the pinned image: `every_type_mv` holds 4 rows), so it is listed with neither.
 */
const UNCOUNTED_KINDS: ReadonlySet<string> = new Set(["materialized_view"]);

export async function listObjects(
  runner: DatabendStatementRunner,
  container: DatabendContainer,
  kind: string,
): Promise<DatabaseObject[]> {
  const rows = await readCompleteRows(runner, databendObjectListSql(container, kind), "object list");
  const counted = !UNCOUNTED_KINDS.has(kind);
  return rows.map((row) => {
    const name = readText(row.object_name);
    const rowCount = counted ? readNumber(row.num_rows) : undefined;
    const sizeBytes = counted ? readNumber(row.data_compressed_size) : undefined;
    const object: DatabaseObject = { path: [container.catalog, container.database, name], name, kind };
    return Object.assign(
      object,
      rowCount === undefined ? {} : { rowCount },
      sizeBytes === undefined ? {} : { sizeBytes },
    );
  });
}

/** One `system.columns` row as a column: no key exists in Databend, and a default only where `default_kind` is set. */
function columnOf(row: Record<string, unknown>): ColumnSchema {
  const defaultKind = readText(row.default_kind);
  return {
    name: readText(row.column_name),
    type: readText(row.data_type),
    nullable: row.is_nullable === "YES",
    isPrimary: false,
    ...(defaultKind === "" ? {} : { defaultValue: readText(row.default_expression) }),
  };
}

/**
 * The columns of an index `definition`, `<table>(<col, col>)<options>` (`indexes_table.rs:112-123`), read after the
 * known table name; a definition that does not start with it names no columns Studio can place.
 */
export function databendIndexColumns(object: string, definition: string): string[] {
  const head = `${object}(`;
  if (!definition.startsWith(head)) return [];
  const list = definition.slice(head.length, definition.indexOf(")", head.length));
  return list.split(", ");
}

/** One object's columns and indexes; an object Databend lists no columns for is refused by name. */
export async function describeObject(
  runner: DatabendStatementRunner,
  container: DatabendContainer,
  kind: string,
  object: string,
): Promise<ObjectDetail> {
  const columnRows = await readCompleteRows(runner, databendColumnsSql(container, kind, object), "column list");
  // Every Databend table has a column, so no rows is a view that no longer plans (or an object since dropped).
  if (columnRows.length === 0) throw new QueryError(DATABEND_OBJECT_SENTENCES.noColumns(object), PROVIDER);
  const indexes: IndexSchema[] = [];
  if (container.catalog === DATABEND_DEFAULT_CATALOG) {
    const indexRows = await readCompleteRows(runner, databendIndexesSql(container.database, object), "index list");
    for (const row of indexRows) {
      indexes.push({
        name: readText(row.index_name),
        columns: databendIndexColumns(object, readText(row.definition)),
        // Search indexes, never keys: no index is unique.
        unique: false,
      });
    }
  }
  return {
    path: [container.catalog, container.database, object],
    columns: columnRows.map(columnOf),
    indexes,
    foreignKeys: [],
  };
}

/**
 * Every object of one kind with its columns: the names from `system.tables`, then every column from one statement.
 * With a caller's `limit` both read one object more, so the names say whether the kind holds more; an object with no
 * column rows (a view that no longer plans) still counts toward the limit and is left out by name in `truncated`. A
 * budget cut can fall inside an object's rows, so the last object read is dropped and `truncated` carries the count
 * kept with the bound's sentence [X05]. Index reads stay with `describeObject`: they would be a statement per object.
 */
export async function describeObjects(
  runner: DatabendStatementRunner,
  container: DatabendContainer,
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  // A safe integer, so `limit + 1` is exact and interpolates as plain digits.
  if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) {
    throw new QueryError(DATABEND_OBJECT_SENTENCES.badLimit(limit), PROVIDER);
  }
  const bound = limit === undefined ? undefined : limit + 1;
  const nameRows = await readCompleteRows(runner, databendObjectNamesSql(container, kind, bound), "object list");
  const names = nameRows.map((row) => readText(row.object_name));
  const { rows, truncated } = await readRows(runner, databendBulkColumnsSql(container, kind, bound));

  const grouped = new Map<string, ColumnSchema[]>();
  for (const row of rows) {
    const name = readText(row.object_name);
    const columns = grouped.get(name) ?? [];
    columns.push(columnOf(row));
    grouped.set(name, columns);
  }
  let objects: [string, ColumnSchema[]][];
  let cut: ObjectDetailBatch["truncated"];
  if (truncated !== null) {
    objects = [...grouped].slice(0, -1);
    cut = { limit: objects.length, reason: DATABEND_OBJECT_SENTENCES.bulkCut(truncated) };
  } else {
    const bounded = limit !== undefined && names.length > limit;
    const wanted = bounded ? names.slice(0, limit) : names;
    objects = wanted.flatMap((name) => {
      const columns = grouped.get(name);
      return columns === undefined ? [] : [[name, columns] as [string, ColumnSchema[]]];
    });
    const missing = wanted.filter((name) => !grouped.has(name));
    const reasons = [
      ...(bounded ? [callerBoundTruncationReason(limit)] : []),
      ...(missing.length === 0 ? [] : [DATABEND_OBJECT_SENTENCES.noColumnsLeftOut(missing)]),
    ];
    if (reasons.length > 0) cut = { limit: bounded ? limit : objects.length, reason: reasons.join(", and ") };
  }

  const details = objects.map(([name, columns]) => ({
    path: [container.catalog, container.database, name],
    columns,
    indexes: [],
    foreignKeys: [],
  }));
  return cut === undefined ? { details } : { details, truncated: cut };
}

/**
 * One object's DDL as one part: the engine's re-rendering, which runs as given, so `complete`, and stays so under a
 * caller's bound, which only marks the part. The statement budget keeps or drops the answer's one row whole and never
 * cuts the text inside it, so a read the budget reached is refused naming the bound, as the other reads are [X05],
 * rather than handed over. Databend lists an object for any grant on it, but `SHOW CREATE` needs SELECT on the object,
 * or for a materialized view on its source table (`visibility_checker.rs`, `privilege_access.rs`), so a listed
 * object's definition can be refused with 1063: that refusal is the part, Databend's own words through `serverWords`,
 * never a raise. An object Databend does not hold is Databend's own error (1025, 1003), and an answer with no
 * definition text is raised naming the object, never a part.
 */
export async function readObjectSource(
  runner: DatabendStatementRunner,
  container: DatabendContainer,
  kind: string,
  object: string,
  secretForms: readonly string[],
  limit?: number,
): Promise<ObjectSourceDocument> {
  const sql = databendSourceSql(container, kind, object);
  const path = [container.catalog, container.database, object];
  let rows: Record<string, unknown>[];
  try {
    rows = await readCompleteRows(runner, sql, "definition");
  } catch (error) {
    // Only the statement's own error is the server's words alone; every other failure says nothing about the object.
    if (error instanceof DatabendError && error.category === "statement" && error.code === PERMISSION_DENIED_CODE) {
      const unavailable = serverWords(error.message, secretForms);
      return {
        path,
        kind,
        parts: [{ id: DATABEND_SOURCE_PART_ID, label: DATABEND_OBJECT_SENTENCES.sourceLabel, unavailable }],
      };
    }
    throw error;
  }
  const text = readText(rows[0]?.[SOURCE_COLUMN]);
  if (text.trim() === "") throw new QueryError(DATABEND_OBJECT_SENTENCES.noDefinition(object), PROVIDER, sql);
  const bounded = applySourceBound(text, limit);
  return {
    path,
    kind,
    parts: [
      {
        id: DATABEND_SOURCE_PART_ID,
        label: DATABEND_OBJECT_SENTENCES.sourceLabel,
        text: bounded.text,
        language: "sql",
        form: "complete",
        origin: "regenerated",
        ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
      },
    ],
  };
}
