/**
 * The object surface over the provider's metadata session: every read is a statement this module writes, sent as a
 * command that Spark answers inline with no job, and every answer is read by column name, whole or not at all.
 */
import { applySourceBound, callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  Container,
  DatabaseObject,
  DatabaseProvider,
  KindCount,
  ObjectDetail,
  ObjectSourceDocument,
} from "@/lib/db/types";
import type { ColumnSchema } from "@/lib/types";
import {
  SPARK_DESCRIBE_OBJECTS_MAX,
  SPARK_INTROSPECT_IN_FLIGHT_MAX,
  SPARK_NAMESPACE_MAX_PARTS,
  SPARK_NAMESPACE_WALK_MAX,
  SPARK_SESSION_CATALOG,
} from "./constants";
import { SPARK_ERROR_SENTENCES, SparkError } from "./errors";
import type { SparkStatementResult } from "./execute";
import { parseNamespaceSpelling, qualifiedName, quoteSparkName } from "./namespace";

export type SparkMetadataRunner = (sql: string) => Promise<SparkStatementResult>;

export interface SparkIntrospectDeps {
  runSql: SparkMetadataRunner;
  /** The keys of Config `get_all` under `prefix`, the prefix removed, as Spark answers them; never their values. */
  confKeys(prefix: string): Promise<readonly string[]>;
}

/** The tree's own sentences. */
export const SPARK_INTROSPECT_SENTENCES = Object.freeze({
  listTooLarge:
    "Spark's answer for this list is larger than Studio reads for its tree (100,000 rows or 16 MiB), so the list is not shown. Query its objects by name.",
  batchBound:
    "Spark's answer for this list is larger than the batch size this server allows for a command's answer (spark.connect.grpc.arrow.maxBatchSize), so the list is not shown. Query its objects by name.",
  walkBound:
    "This catalog has more than 1,000 namespaces, or nests them more than 8 levels deep, more than Studio walks for its tree. Query its objects by name.",
  namespaceNotReadable: "Studio cannot read this namespace as Spark spells it, so no statement was sent.",
  namespaceListingNotReadable:
    "Spark listed a namespace that is not inside the one Studio asked about, so the list is not shown.",
  noKind: (kind: string) => `Apache Spark has no object kind "${kind}" in Studio's tree.`,
  noColumns: (kind: string) => `Studio reads no columns for an Apache Spark ${kind}.`,
  noSource: (kind: string) => `Studio reads no definition for an Apache Spark ${kind}.`,
  /** A bulk column read's truncation reason, so no full stop: its readers set it inside a sentence of their own. */
  describeBound: `Studio describes at most ${SPARK_DESCRIBE_OBJECTS_MAX.toLocaleString("en-US")} objects in one read, since Apache Spark needs one DESCRIBE TABLE per object`,
  badLimit: (limit: number) =>
    `An Apache Spark bulk column read limit must be a positive whole number, received ${limit}.`,
});

type Row = Readonly<Record<string, unknown>>;

/**
 * A namespace SHOW NAMESPACES listed: Spark's spelling, which names it in the tree, and its parts, from which a
 * statement names it.
 */
interface Listed {
  readonly parts: readonly string[];
  readonly spelling: string;
}

/** A `[catalog, namespace]` container, read once for the statements that name it. */
interface Place {
  readonly catalog: string;
  readonly spelling: string;
  readonly parts: readonly string[];
  /** The catalog and every part of the namespace, each quoted. */
  readonly name: string;
}

/** A metadata answer, whole or not at all: a cut answer and an answer past a message or batch bound are refused. */
async function readWhole(deps: SparkIntrospectDeps, sql: string): Promise<readonly Row[]> {
  let answer: SparkStatementResult;
  try {
    answer = await deps.runSql(sql);
  } catch (error) {
    if (error instanceof SparkError && error.category === "receive-cap") {
      throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.listTooLarge, { cause: error });
    }
    if (error instanceof SparkError && error.category === "command-batch-bound") {
      throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.batchBound, { cause: error });
    }
    throw error;
  }
  if (answer.cut !== null) throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.listTooLarge);
  return answer.rows;
}

function unreadable(what: string): SparkError {
  return new SparkError("unreadable", SPARK_ERROR_SENTENCES.unreadable(what));
}

function cell(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") throw unreadable(`the ${column} column of Spark's answer`);
  return value;
}

function temporary(row: Row): boolean {
  const value = row.isTemporary;
  if (typeof value !== "boolean") throw unreadable("the isTemporary column of Spark's answer");
  return value;
}

/** Whether Spark refused a listing because the catalog cannot hold this kind of object. */
function lacksAbility(error: unknown, ability: "VIEWS" | "FUNCTIONS"): boolean {
  return (
    error instanceof SparkError &&
    error.category === "spark" &&
    error.message.includes(`MISSING_CATALOG_ABILITY.${ability}`)
  );
}

/** Whether Spark refused a statement because the table or view it names does not exist: the class its text opens with. */
function tableOrViewNotFound(error: unknown): boolean {
  return (
    error instanceof SparkError && error.category === "spark" && error.message.startsWith("[TABLE_OR_VIEW_NOT_FOUND]")
  );
}

/**
 * The classes Spark refuses SHOW CREATE TABLE with for an object it holds: a temporary view, a metric view, a
 * transactional Hive table, and a Hive table whose features or serde configuration the statement cannot print. Spark
 * 4.1.3 and 4.2.0 answer a temporary view with EXPECT_PERMANENT_VIEW_NOT_TEMP before the command's own refusal is
 * reached. The command's AS SERDE refusal is left out, since Studio never sends that form.
 */
const SOURCE_REFUSALS: readonly string[] = [
  "EXPECT_PERMANENT_VIEW_NOT_TEMP",
  "UNSUPPORTED_SHOW_CREATE_TABLE.ON_TEMPORARY_VIEW",
  "UNSUPPORTED_SHOW_CREATE_TABLE.ON_METRIC_VIEW",
  "UNSUPPORTED_SHOW_CREATE_TABLE.ON_TRANSACTIONAL_HIVE_TABLE",
  "UNSUPPORTED_SHOW_CREATE_TABLE.WITH_UNSUPPORTED_FEATURE",
  "UNSUPPORTED_SHOW_CREATE_TABLE.WITH_UNSUPPORTED_SERDE_CONFIGURATION",
];

/** Whether Spark refused a definition read with one of SOURCE_REFUSALS: the class its text opens with. */
function sourceRefused(error: unknown): error is SparkError {
  return (
    error instanceof SparkError &&
    error.category === "spark" &&
    SOURCE_REFUSALS.some((refusal) => error.message.startsWith(`[${refusal}]`))
  );
}

async function currentNamespace(deps: SparkIntrospectDeps): Promise<{ catalog: string; spelling: string }> {
  const [row] = await readWhole(deps, "SHOW CURRENT NAMESPACE");
  if (row === undefined) throw unreadable("SHOW CURRENT NAMESPACE");
  return { catalog: cell(row, "catalog"), spelling: cell(row, "namespace") };
}

/**
 * A namespace as a statement names it: every part quoted. Spark spells a namespace with quoteIfNeeded, which leaves a
 * reserved word such as select bare, and under spark.sql.ansi.enforceReservedKeywords=true a statement that names it
 * bare does not parse; quoted, every part reads as a name whatever the session's settings.
 */
function quotedNamespace(parts: readonly string[]): string {
  return parts.map(quoteSparkName).join(".");
}

/**
 * The container at the head of a path of `length` segments: a path of any other length, or a namespace spelling that
 * `parseNamespaceSpelling` does not read completely, is refused before any statement is built.
 */
function placeOf(path: readonly string[], length: 2 | 3): Place {
  const [catalog, spelling] = path;
  const parts = path.length === length ? parseNamespaceSpelling(spelling) : undefined;
  if (parts === undefined) throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.namespaceNotReadable);
  return { catalog, spelling, parts, name: qualifiedName(catalog, quotedNamespace(parts)) };
}

/** A `[catalog, namespace, name]` path as a statement's name, every part quoted. */
function objectName(path: readonly string[]): string {
  const place = placeOf(path, 3);
  return qualifiedName(place.catalog, quotedNamespace(place.parts), path[2]);
}

export async function listCatalogs(deps: SparkIntrospectDeps): Promise<Container[]> {
  const current = await currentNamespace(deps);
  const listed = (await readWhole(deps, "SHOW CATALOGS")).map((row) => cell(row, "catalog"));
  // A key with no further dot names a configured catalog plugin; the values are never read.
  const configured = (await deps.confKeys("spark.sql.catalog.")).filter((key) => key !== "" && !key.includes("."));
  const others = [...new Set([...listed, ...configured])]
    .filter((name) => name !== current.catalog)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    { path: [current.catalog], name: current.catalog, level: 0, isSessionDefault: true },
    ...others.map((name) => ({ path: [name], name, level: 0 })),
  ];
}

/** The namespaces SHOW NAMESPACES lists inside `parent` (the catalog itself at the top), each read as its parts. */
async function listChildren(deps: SparkIntrospectDeps, catalog: string, parent: Listed | undefined): Promise<Listed[]> {
  const target = parent === undefined ? quoteSparkName(catalog) : qualifiedName(catalog, quotedNamespace(parent.parts));
  const rows = await readWhole(deps, `SHOW NAMESPACES IN ${target}`);
  const above = parent?.parts ?? [];
  if (above.length >= SPARK_NAMESPACE_MAX_PARTS && rows.length > 0) {
    throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.walkBound);
  }
  return rows.map((row) => {
    const spelling = cell(row, "namespace");
    const parts = parseNamespaceSpelling(spelling);
    if (parts === undefined || parts.length <= above.length || above.some((part, i) => parts[i] !== part)) {
      throw new SparkError("unreadable", SPARK_INTROSPECT_SENTENCES.namespaceListingNotReadable);
    }
    return { parts, spelling };
  });
}

/**
 * `top` and every namespace below it, breadth first, at most SPARK_INTROSPECT_IN_FLIGHT_MAX statements in flight at
 * once; once more than SPARK_NAMESPACE_WALK_MAX are found, the walk is refused before its next batch is sent. A batch
 * that failed raises its first failure in batch order only once every statement in it has answered, so no statement of
 * the walk outlives the call.
 */
async function walkBelow(deps: SparkIntrospectDeps, catalog: string, top: readonly Listed[]): Promise<Listed[]> {
  const found = [...top];
  let level = top;
  while (level.length > 0) {
    const next: Listed[] = [];
    for (let i = 0; i < level.length; i += SPARK_INTROSPECT_IN_FLIGHT_MAX) {
      if (found.length + next.length > SPARK_NAMESPACE_WALK_MAX) {
        throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.walkBound);
      }
      const batch = level.slice(i, i + SPARK_INTROSPECT_IN_FLIGHT_MAX);
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time keeps the walk within its in-flight bound.
      const answers = await Promise.allSettled(batch.map((parent) => listChildren(deps, catalog, parent)));
      for (const answer of answers) {
        if (answer.status === "rejected") throw answer.reason;
        for (const child of answer.value) next.push(child);
      }
    }
    for (const child of next) found.push(child);
    level = next;
  }
  return found;
}

export async function listNamespaces(deps: SparkIntrospectDeps, catalog: string): Promise<Container[]> {
  const current = await currentNamespace(deps);
  const top = await listChildren(deps, catalog, undefined);
  // The session catalog holds single-level databases only, so it costs one statement; every other catalog is walked.
  const found = catalog === SPARK_SESSION_CATALOG ? top : await walkBelow(deps, catalog, top);
  const currentParts = catalog === current.catalog ? parseNamespaceSpelling(current.spelling) : undefined;
  return found.map(({ parts, spelling }): Container => {
    const path = [catalog, spelling];
    const isDefault =
      currentParts !== undefined &&
      currentParts.length === parts.length &&
      currentParts.every((p, i) => p === parts[i]);
    return isDefault ? { path, name: spelling, level: 1, isSessionDefault: true } : { path, name: spelling, level: 1 };
  });
}

async function viewNames(deps: SparkIntrospectDeps, place: Place): Promise<string[]> {
  let rows: readonly Row[];
  try {
    rows = await readWhole(deps, `SHOW VIEWS IN ${place.name}`);
  } catch (error) {
    if (lacksAbility(error, "VIEWS")) return [];
    throw error;
  }
  return rows.filter((row) => !temporary(row)).map((row) => cell(row, "viewName"));
}

/** SHOW TABLES lists persistent views with tables on the session catalog, so the views are taken out. */
async function tableNames(deps: SparkIntrospectDeps, place: Place, views: readonly string[]): Promise<string[]> {
  const rows = await readWhole(deps, `SHOW TABLES IN ${place.name}`);
  const isView = new Set(views);
  return rows
    .filter((row) => !temporary(row))
    .map((row) => cell(row, "tableName"))
    .filter((name) => !isView.has(name));
}

/**
 * Spark prints a function's name unquoted and lower-cased after `<catalog>.<namespace>.`, and a name can hold a dot,
 * so the name is the text after the prefix the statement asked for, compared without case; a row without it is skipped.
 */
async function functionNames(deps: SparkIntrospectDeps, place: Place): Promise<string[]> {
  let rows: readonly Row[];
  try {
    rows = await readWhole(deps, `SHOW USER FUNCTIONS IN ${place.name}`);
  } catch (error) {
    if (lacksAbility(error, "FUNCTIONS")) return [];
    throw error;
  }
  const prefix = `${[place.catalog, ...place.parts].join(".")}.`.toLowerCase();
  const names: string[] = [];
  for (const row of rows) {
    const text = cell(row, "function");
    if (text.length > prefix.length && text.toLowerCase().startsWith(prefix)) names.push(text.slice(prefix.length));
  }
  return names;
}

export async function listObjects(
  deps: SparkIntrospectDeps,
  container: readonly string[],
  kind: string,
): Promise<DatabaseObject[]> {
  const place = placeOf(container, 2);
  let names: string[];
  if (kind === "table") names = await tableNames(deps, place, await viewNames(deps, place));
  else if (kind === "view") names = await viewNames(deps, place);
  else if (kind === "function") names = await functionNames(deps, place);
  else throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.noKind(kind));
  return names.map((name) => ({ path: [place.catalog, place.spelling, name], name, kind }));
}

export async function countObjects(
  deps: SparkIntrospectDeps,
  container: readonly string[],
): Promise<Record<string, KindCount>> {
  const place = placeOf(container, 2);
  const views = await viewNames(deps, place);
  const tables = await tableNames(deps, place, views);
  const functions = await functionNames(deps, place);
  return { table: { count: tables.length }, view: { count: views.length }, function: { count: functions.length } };
}

/** A table's or a view's columns from DESCRIBE TABLE; a function has none: three empty lists, no statement. */
export async function describeObject(
  deps: SparkIntrospectDeps,
  path: readonly string[],
  kind: string,
): Promise<ObjectDetail> {
  if (kind === "function") return { path: [...path], columns: [], indexes: [], foreignKeys: [] };
  if (kind !== "table" && kind !== "view") throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.noColumns(kind));
  const rows = await readWhole(deps, `DESCRIBE TABLE ${objectName(path)}`);
  const columns: ColumnSchema[] = [];
  for (const row of rows) {
    const name = cell(row, "col_name");
    const type = cell(row, "data_type");
    // Spark's section headers carry an empty data_type; a column may be named `#tag` and keeps its type.
    if (name === "" || (name.startsWith("#") && type === "")) break;
    // DESCRIBE TABLE prints no nullability, and a Spark column is nullable unless declared NOT NULL.
    columns.push({ name, type, nullable: true, isPrimary: false });
  }
  return { path: [...path], columns, indexes: [], foreignKeys: [] };
}

/**
 * One DESCRIBE TABLE per object, in listing order and one at a time: OSS Spark has no catalog view that lists every
 * table's columns. At most `limit` objects and never more than SPARK_DESCRIBE_OBJECTS_MAX, with the reason of the bound
 * that bit when more remain; a `limit` that is not a positive whole number is refused, whatever the kind, before any
 * statement. An object dropped since the listing is left out, since callers match details to objects by path; any other
 * failure fails the whole read.
 */
export async function describeObjects(
  deps: SparkIntrospectDeps,
  ...[container, kind, limit]: Parameters<DatabaseProvider["describeObjects"]>
): ReturnType<DatabaseProvider["describeObjects"]> {
  // Refused rather than clamped: a 0 would describe nothing yet report a truncation, and a negative limit would slice
  // from the listing's end, past SPARK_DESCRIBE_OBJECTS_MAX. Any whole number above 0 is a bound, however large: no
  // statement carries it and nothing adds to it, so one past the safe integers is held to the cap like any other.
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.badLimit(limit));
  }
  if (kind === "function") return { details: [] };
  const objects = await listObjects(deps, container, kind);
  const bound = Math.min(limit ?? SPARK_DESCRIBE_OBJECTS_MAX, SPARK_DESCRIBE_OBJECTS_MAX);
  const details: ObjectDetail[] = [];
  for (const object of objects.slice(0, bound)) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one DESCRIBE at a time on the metadata session.
      details.push(await describeObject(deps, object.path, kind));
    } catch (error) {
      // A table or view dropped since the listing has nothing left to describe.
      if (!tableOrViewNotFound(error)) throw error;
    }
  }
  if (objects.length <= bound) return { details };
  return { details, truncated: { limit: bound, reason: describeBoundReason(limit) } };
}

/**
 * Why a bulk column read stopped short: under a limit at or below SPARK_DESCRIBE_OBJECTS_MAX the caller's, and with no
 * limit or a larger one Studio's own cap, in the provider's sentence: the inventory's sentence names another bound.
 */
function describeBoundReason(limit: number | undefined): string {
  return limit === undefined || limit > SPARK_DESCRIBE_OBJECTS_MAX
    ? SPARK_INTROSPECT_SENTENCES.describeBound
    : callerBoundTruncationReason(limit);
}

/**
 * A table's or a view's definition from SHOW CREATE TABLE, as one part. A refusal SOURCE_REFUSALS lists is the part's
 * unavailable sentence, Spark's own text; any other failure fails the read, a missing object with Spark's text, which
 * names it.
 */
export async function readObjectSource(
  deps: SparkIntrospectDeps,
  path: readonly string[],
  kind: string,
  limit?: number,
): Promise<ObjectSourceDocument> {
  if (kind !== "table" && kind !== "view") throw new SparkError("refused", SPARK_INTROSPECT_SENTENCES.noSource(kind));
  const name = objectName(path);
  let text: string;
  try {
    const [row] = await readWhole(deps, `SHOW CREATE TABLE ${name}`);
    if (row === undefined) throw unreadable("SHOW CREATE TABLE");
    text = cell(row, "createtab_stmt");
  } catch (error) {
    if (sourceRefused(error)) {
      return { path: [...path], kind, parts: [{ id: "ddl", label: "Definition", unavailable: error.message }] };
    }
    throw error;
  }
  const bounded = applySourceBound(text, limit);
  const origin = kind === "table" ? "regenerated" : "stored";
  const part = {
    id: "ddl",
    label: "Definition",
    text: bounded.text,
    language: "sql",
    form: "complete",
    origin,
  } as const;
  return {
    path: [...path],
    kind,
    parts: [bounded.truncated === undefined ? part : { ...part, truncated: bounded.truncated }],
  };
}
