/**
 * The Db2 object surface: schemas, the nine kinds, their detail and their definitions (#786).
 *
 * Every function here takes a `CatalogReader` rather than a client, so the surface is the same
 * code whichever way the provider reaches the catalog, and a test can drive every arm without a
 * driver. The reader answers rows with their `_HEX` columns already decoded (see `catalog.ts`).
 */

import type {
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ProviderCapabilities,
} from "@/lib/db/types";
import {
  applySourceBound,
  assertContainerPathShape,
  assertObjectPathShape,
  callerBoundTruncationReason,
  type ContainerPathShapeEngine,
  declaredLevels,
  enumerableKinds,
  findKind,
  type ObjectPathShapeEngine,
  requireSourceKind,
} from "../../../object-kinds";
import { comparePaths } from "../../../object-path";
import { QueryError } from "../../../errors";
import {
  CONTAINERS_SQL,
  COUNT_KINDS,
  COUNTS_SQL,
  LIST_MODULES_SQL,
  LIST_ROUTINES_SQL,
  LIST_SEQUENCES_SQL,
  LIST_TABLES_SQL,
  LIST_TRIGGERS_SQL,
  OBJECT_COLUMNS_SQL,
  OBJECT_FOREIGN_KEYS_SQL,
  OBJECT_INDEXES_SQL,
  ROUTINE_SOURCE,
  ROUTINE_TYPES,
  SCHEMA_TRIGGER_SOURCE,
  SOURCE_BYTE_LIMIT,
  TABLE_TRIGGER_SOURCE,
  TABLE_TYPES,
  VIEW_SOURCE,
  bulkDetailSql,
  bulkTargetSql,
  objectDetailFromRows,
  objectStatus,
  sourceLength,
  sourceText,
  type SourceStatements,
  SOURCE_CHUNK_BYTES,
} from "./catalog";

/** How the object surface reaches the catalog. */
export interface CatalogReader {
  /** One statement's rows, every `_HEX` column decoded. */
  read(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /** The database's code page, for the text `read` leaves as bytes. */
  codePage(): Promise<number>;
}

/** Db2's identity for the shared container-path refusal. */
const DB2_CONTAINER_PATH_ENGINE: ContainerPathShapeEngine = { code: "db2", label: "A Db2", shapeNames: "label" };

/**
 * A trigger takes either depth: `[schema, table, trigger]` when its table is in its own schema,
 * and `[schema, trigger]` when it is not, which Db2 allows.
 */
const PATH_SHAPE_ENGINE: ObjectPathShapeEngine = { code: "db2", label: "A Db2", attachedSegment: "optional" };

const DISPLAY = { displayName: "Db2", type: "db2" } as const;

/**
 * The segment of `path` the declaration assigns to its `schema` level. Never `path[0]` by
 * position: the level's place is a property of the declaration.
 */
function schemaSegment(capabilities: ProviderCapabilities, path: readonly string[]): string {
  const levels = declaredLevels(capabilities);
  const index = levels.findIndex((level) => level.id === "schema");
  const segment = index < 0 ? undefined : path.slice(0, levels.length)[index];
  if (segment === undefined) {
    throw new QueryError(
      `A Db2 path needs a "schema" container level and a segment for it; the declaration is ` +
        `[${levels.map((level) => level.id).join(", ")}] and the path is ${JSON.stringify(path)}`,
      "db2",
    );
  }
  return segment;
}

/** The schema a container path names, after the declared shape has accepted it. */
function containerSchema(capabilities: ProviderCapabilities, container: readonly string[]): string {
  assertContainerPathShape(capabilities, container, DB2_CONTAINER_PATH_ENGINE);
  return schemaSegment(capabilities, container);
}

/** A kind the declaration names, or a refusal in this engine's words. */
function declaredKind(capabilities: ProviderCapabilities, kind: string): ObjectKindSpec {
  const spec = findKind(capabilities, kind);
  if (spec === undefined) throw new QueryError(`Db2 declares no object kind "${kind}"`, "db2");
  return spec;
}

// ============================================================================
// Containers and counts
// ============================================================================

/** The user schemas. One level, so nothing nests under one. */
export async function listContainers(reader: CatalogReader, parent?: readonly string[]): Promise<Container[]> {
  if (parent !== undefined && parent.length > 0) return [];
  const rows = await reader.read(CONTAINERS_SQL, []);
  return rows
    .map((row) => ({
      path: [String(row.NAME)],
      name: String(row.NAME),
      level: 0,
      isSessionDefault: Number(row.IS_SESSION_DEFAULT) === 1,
    }))
    .sort((left, right) => comparePaths(left.path, right.path));
}

/**
 * Every enumerable kind's count in one schema, from one statement.
 *
 * A kind the statement did not answer for is 0, because it was seeded before the read. A refused
 * read carries the server's own sentence for every kind and never a 0, deliberately NOT through
 * `mapDatabaseError`: nothing here throws, and the sentence is shown as the reason a folder has
 * no number.
 */
export async function countObjects(
  reader: CatalogReader,
  capabilities: ProviderCapabilities,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const schema = containerSchema(capabilities, container);
  const kinds = enumerableKinds(capabilities);
  let rows: Record<string, unknown>[];
  try {
    rows = await reader.read(COUNTS_SQL, [schema, schema, schema, schema, schema]);
  } catch (error) {
    const unavailable = error instanceof Error ? error.message : String(error);
    return Object.fromEntries(kinds.map((kind) => [kind.id, { unavailable } as KindCount]));
  }
  const counts: Record<string, KindCount> = Object.fromEntries(kinds.map((kind) => [kind.id, { count: 0 }]));
  for (const row of rows) {
    const kind = COUNT_KINDS[String(row.KIND)];
    if (kind !== undefined && Object.hasOwn(counts, kind)) counts[kind] = { count: Number(row.N) };
  }
  return counts;
}

// ============================================================================
// Listings
// ============================================================================

/** Which statement lists one kind, and with which binds. */
function listingStatement(schema: string, kind: string): { sql: string; params: unknown[] } | undefined {
  if (Object.hasOwn(TABLE_TYPES, kind)) return { sql: LIST_TABLES_SQL, params: [schema, TABLE_TYPES[kind]] };
  if (Object.hasOwn(ROUTINE_TYPES, kind)) return { sql: LIST_ROUTINES_SQL, params: [schema, ROUTINE_TYPES[kind]] };
  if (kind === "sequence") return { sql: LIST_SEQUENCES_SQL, params: [schema] };
  if (kind === "module") return { sql: LIST_MODULES_SQL, params: [schema] };
  if (kind === "trigger") return { sql: LIST_TRIGGERS_SQL, params: [schema] };
  return undefined;
}

/** The kinds whose catalog `CARD` is a row count worth showing. */
const COUNTED_KINDS = new Set(["table", "materialized_query_table"]);

/**
 * The address of one listed object: the container, its parent table when it has one in its own
 * schema, and its specific name when it is a routine and its name otherwise.
 */
function objectPath(container: readonly string[], row: Record<string, unknown>): string[] {
  const last = String(row.SEGMENT ?? row.NAME);
  const parent = row.PARENT;
  return typeof parent === "string" ? [...container, parent, last] : [...container, last];
}

/** The objects of one kind in one schema, sorted by address. */
export async function listObjects(
  reader: CatalogReader,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  const schema = containerSchema(capabilities, container);
  declaredKind(capabilities, kind);
  const statement = listingStatement(schema, kind);
  if (statement === undefined) {
    throw new QueryError(`Db2 declares the kind "${kind}" but has no statement that lists it`, "db2");
  }
  const rows = await reader.read(statement.sql, statement.params);
  return rows
    .map((row) => {
      const card = row.CARD;
      const rowCount = COUNTED_KINDS.has(kind) && typeof card === "number" && card >= 0 ? { rowCount: card } : {};
      return { path: objectPath(container, row), name: String(row.NAME), kind, ...objectStatus(row), ...rowCount };
    })
    .sort((left, right) => comparePaths(left.path, right.path));
}

// ============================================================================
// Detail
// ============================================================================

/** The three detail reads of one relation, in sequence on the one client. */
export async function describeObject(
  reader: CatalogReader,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  const spec = declaredKind(capabilities, kind);
  assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);
  // Only a relation has columns; an alias is a catalog row naming one, and has none of its own.
  if (spec.hasColumns !== true) return { path: [...path], columns: [], indexes: [], foreignKeys: [] };

  const schema = schemaSegment(capabilities, path);
  const binds = [schema, path[path.length - 1]];
  const columns = await reader.read(OBJECT_COLUMNS_SQL, binds);
  const foreignKeys = await reader.read(OBJECT_FOREIGN_KEYS_SQL, binds);
  const indexes = await reader.read(OBJECT_INDEXES_SQL, binds);
  return objectDetailFromRows(path, schema, { columns, foreignKeys, indexes }, await reader.codePage());
}

/** The rows of one bulk read grouped by the object they belong to. */
function byObjectName(rows: readonly Record<string, unknown>[]): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const name = String(row.OBJECT_NAME);
    const group = grouped.get(name) ?? [];
    group.push(row);
    grouped.set(name, group);
  }
  return grouped;
}

/**
 * Every relation of one kind in one schema, described in four round trips: the target set, then
 * columns, foreign keys and indexes each scoped to it.
 *
 * The bound is the caller's and is never invented. The target is read at `limit + 1`, so a
 * saturated read says so without a second count, and the extra object is dropped.
 */
export async function describeObjects(
  reader: CatalogReader,
  capabilities: ProviderCapabilities,
  container: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectDetailBatch> {
  const spec = declaredKind(capabilities, kind);
  const schema = containerSchema(capabilities, container);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new QueryError(`A Db2 bulk column read limit must be a positive whole number, received ${limit}`, "db2");
  }
  if (spec.hasColumns !== true) return { details: [] };

  const bounded = limit !== undefined;
  const type = TABLE_TYPES[kind];
  const binds: unknown[] = bounded ? [schema, type, limit + 1] : [schema, type];
  const targets = await reader.read(bulkTargetSql(bounded), binds);
  const truncated = bounded && targets.length > limit;
  const described = truncated ? targets.slice(0, limit) : targets;
  if (described.length === 0) return { details: [] };

  const statements = bulkDetailSql(bounded);
  const detailBinds = [...binds, schema];
  const columns = byObjectName(await reader.read(statements.columns, detailBinds));
  const foreignKeys = byObjectName(await reader.read(statements.foreignKeys, detailBinds));
  const indexes = byObjectName(await reader.read(statements.indexes, detailBinds));
  const codePage = await reader.codePage();

  const details = described
    .map((row) => {
      const name = String(row.OBJECT_NAME);
      return objectDetailFromRows(
        [...container, name],
        schema,
        {
          columns: columns.get(name) ?? [],
          foreignKeys: foreignKeys.get(name) ?? [],
          indexes: indexes.get(name) ?? [],
        },
        codePage,
      );
    })
    .sort((left, right) => comparePaths(left.path, right.path));
  return truncated ? { details, truncated: { limit, reason: callerBoundTruncationReason(limit) } } : { details };
}

// ============================================================================
// Source
// ============================================================================

/** Why a routine has no SQL text, by its `ORIGIN`. */
const NO_TEXT_BY_ORIGIN: Readonly<Record<string, string>> = {
  E: "EXTERNAL routine: its body is compiled code outside the database.",
  U: "SOURCED routine: it is defined as another function, with no body of its own.",
  F: "FEDERATED procedure: its body lives on the remote data source.",
};

/** The sentence a definition longer than the byte bound carries. */
export const SOURCE_TRUNCATION_REASON =
  `Db2 stores this definition as a CLOB longer than ${SOURCE_BYTE_LIMIT} bytes, and db2-node 1.0.22 cannot fetch a ` +
  `CLOB, so only the first ${SOURCE_BYTE_LIMIT} bytes are shown.`;

/** Which statements read one object's definition, and with which binds. */
function sourceStatement(
  schema: string,
  path: readonly string[],
  kind: string,
): { statements: SourceStatements; params: unknown[]; where: string } {
  const name = path[path.length - 1];
  if (kind === "trigger" && path.length === 3) {
    return { statements: TABLE_TRIGGER_SOURCE, params: [schema, path[1], name], where: `trigger ${schema}.${name}` };
  }
  if (kind === "trigger") {
    return { statements: SCHEMA_TRIGGER_SOURCE, params: [schema, name], where: `trigger ${schema}.${name}` };
  }
  if (Object.hasOwn(ROUTINE_TYPES, kind)) {
    return {
      statements: ROUTINE_SOURCE,
      params: [schema, name, ROUTINE_TYPES[kind]],
      where: `routine ${schema}.${name}`,
    };
  }
  return { statements: VIEW_SOURCE, params: [schema, name, TABLE_TYPES[kind]], where: `${schema}.${name}` };
}

/**
 * One object's definition, as Db2 stored it.
 *
 * `origin: "stored"` because SYSCAT keeps the author's own statement text, and `form:
 * "complete"` unless the definition is longer than the byte bound, when it is `partial` and
 * says why. No row at all raises, naming the object: a dropped object is the engine's silence.
 * A routine with no text is a refusal part naming what kind of routine it is.
 */
export async function readObjectSource(
  reader: CatalogReader,
  capabilities: ProviderCapabilities,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  const spec = requireSourceKind(capabilities, kind, DISPLAY);
  assertObjectPathShape(capabilities, spec, kind, path, PATH_SHAPE_ENGINE);
  const schema = schemaSegment(capabilities, path);
  const statement = sourceStatement(schema, path, kind);
  const missing = () =>
    new QueryError(`Db2 holds no ${spec.label.toLowerCase()} called "${path[path.length - 1]}" in ${schema}`, "db2");
  const [row] = await reader.read(statement.statements.head, statement.params);
  if (row === undefined) throw missing();

  const length = sourceLength(row);
  const part = { id: "definition", label: "Definition" };
  if (length === null) {
    const origin = row.ORIGIN;
    const unavailable =
      typeof origin !== "string"
        ? `SYSCAT answered no definition text for ${statement.where}.`
        : (NO_TEXT_BY_ORIGIN[origin] ?? `SYSCAT answered no definition text for this routine (ORIGIN ${origin}).`);
    return { path: [...path], kind, parts: [{ ...part, unavailable }] };
  }
  const chunks = [row];
  if (length > SOURCE_CHUNK_BYTES) {
    // The second chunk in a statement of its own (see `SourceStatements`). An object dropped
    // between the two reads answers no row, and is as missing as one the first read did not find.
    const [tail] = await reader.read(statement.statements.tail, statement.params);
    if (tail === undefined) throw missing();
    chunks.push(tail);
  }
  const text = sourceText(chunks, length, await reader.codePage());
  if (text.trim() === "") {
    return { path: [...path], kind, parts: [{ ...part, unavailable: "SYSCAT answered an empty definition." }] };
  }

  const cut = length > SOURCE_BYTE_LIMIT;
  const bounded = applySourceBound(text, limit);
  // The caller's bound, when it bites, is the one a reader can change, so it is the one shown;
  // the byte bound is reported when it is the only one that cut the text.
  const truncated =
    bounded.truncated ?? (cut ? { limit: SOURCE_BYTE_LIMIT, reason: SOURCE_TRUNCATION_REASON } : undefined);
  return {
    path: [...path],
    kind,
    parts: [
      {
        ...part,
        text: bounded.text,
        language: spec.sourceLanguage,
        form: cut ? "partial" : "complete",
        origin: "stored",
        ...(truncated === undefined ? {} : { truncated }),
      },
    ],
  };
}
