/**
 * A Weaviate answer to a `QueryResult` (#1566 spec 5.2): one row per object for the object reads and the searches,
 * whichever path answered, one row for an aggregate count or one per group, and one row per entry for the metadata
 * reads.
 *
 * A search row has the same columns on both paths: `$id`, the properties asked for (every plain property when none
 * is named, which is what REST answers), then `$distance`, `$certainty`, `$score`, `$explainScore`, `$creationTime`
 * and `$lastUpdateTime` as asked, the two times as milliseconds since the epoch on both paths (REST answers a number,
 * GraphQL a string). Neither search path returns a vector (REST has no metadata for it, spec A.10); an object read
 * with `include=vector` does, as `$vector` and `$vector.<name>` columns the grid draws as vectors.
 *
 * Weaviate stores an `int` property as a float64 (spec A.3), so a plain parse loses nothing the server has. On the
 * GraphQL path an int outside int32 answers null, 2^53 - 1 included, so a null in an `int` column there is counted
 * and the result says it may be such a value. Rows are built on `Object.create(null)`; the conversion stops at the
 * byte budget and drops the rest whole; text cells are cut at their bound with a marker; vector cells never are.
 */
import { utf8ByteLength } from "@/lib/db/console/bounds";
import { QueryError } from "@/lib/db/errors";
import { countLabel } from "@/lib/db/vector/count";
import type { VectorColumn } from "@/lib/db/vector/types";
import type { DatabaseType, QueryResult, QueryWarning } from "@/lib/types";
import type { WeaviateConsoleOp } from "./client";
import { GRAPHQL_METADATA } from "./graphql";
import type { WeaviateSearchModel } from "./request";
import { WEAVIATE_BOUNDS } from "./routes";
import { vectorColumnName, type WeaviateCollectionFacts } from "./schema";
import type { WeaviatePath } from "./versions";

const PROVIDER: DatabaseType = "weaviate";

export interface WeaviateResultOptions {
  readonly executionTime: number;
  /** The byte budget; only a test passes another. */
  readonly budgetBytes?: number;
}

/** What a result needs to know about the request that asked for it. */
export interface WeaviateResultShape {
  readonly op: WeaviateConsoleOp;
  /** The collection the request read, or null where it reads none. */
  readonly facts: WeaviateCollectionFacts | null;
  /** The path that answered a search or aggregate; null for every other route. */
  readonly path: WeaviatePath | null;
  readonly model: WeaviateSearchModel | null;
  /** The object list's limit, for the next-page notice; null where the list names offset or sort. */
  readonly limit: number | null;
  /** The object list already names after, so the notice says to replace it rather than add one. */
  readonly afterGiven?: boolean;
  readonly warnings: readonly QueryWarning[];
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new QueryError("Weaviate answered with a body that is not JSON.", PROVIDER);
  }
}

function listOf(value: Json | undefined, what: string): readonly Json[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new QueryError(`Weaviate answered with no list of ${what}.`, PROVIDER);
  return value;
}

/** The notes a conversion gathers, written as warnings once it ends. */
class Notes {
  cutCells = 0;
  int32Nulls = new Set<string>();

  text(value: string): string {
    const limit = WEAVIATE_BOUNDS.stringCellUnits;
    if (value.length <= limit) return value;
    const high = value.charCodeAt(limit - 1);
    const end = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
    this.cutCells += 1;
    return `${value.slice(0, end)}...[cut: ${end} of ${value.length} characters shown]`;
  }

  cell(value: Json | undefined): Json {
    if (value === undefined) return null;
    return typeof value === "string" ? this.text(value) : value;
  }

  warnings(): QueryWarning[] {
    const warnings: QueryWarning[] = [];
    if (this.int32Nulls.size > 0) {
      warnings.push({
        message: `GraphQL answers null for an int outside the 32-bit range, so a null in ${[...this.int32Nulls].join(", ")} may be such a value; Weaviate 1.39.7 and later answer it over REST.`,
      });
    }
    if (this.cutCells > 0) {
      warnings.push({
        message: `${this.cutCells} text cells were longer than ${WEAVIATE_BOUNDS.stringCellUnits} characters and are cut, with a marker.`,
      });
    }
    return warnings;
  }
}

/** The rows within the byte budget, whole; the rest dropped, with a warning naming the bound. */
function budgeted(
  rows: readonly Record<string, unknown>[],
  options: WeaviateResultOptions,
): { readonly kept: readonly Record<string, unknown>[]; readonly warning?: QueryWarning } {
  const budget = options.budgetBytes ?? WEAVIATE_BOUNDS.resultBudgetBytes;
  let bytes = 0;
  for (let index = 0; index < rows.length; index++) {
    bytes += utf8ByteLength(JSON.stringify(rows[index]));
    if (bytes > budget) {
      const bound = budget >= 1_048_576 ? `${budget / 1_048_576} MiB` : `${budget}-byte`;
      return {
        kept: rows.slice(0, index),
        warning: {
          message: `The result reached Studio's ${bound} result budget after ${index} rows; the remaining ${rows.length - index} rows are not shown. Lower the limit, or ask for fewer properties.`,
        },
      };
    }
  }
  return { kept: rows };
}

interface Built {
  readonly fields: readonly string[];
  readonly rows: readonly Record<string, unknown>[];
  readonly columnTypes: Readonly<Record<string, string>>;
  readonly warnings: readonly QueryWarning[];
  readonly vectorColumns?: Readonly<Record<string, VectorColumn>>;
  /** An object list that filled its limit: the next page starts after the last row shown. */
  readonly nextPage?: { readonly limit: number; readonly afterGiven: boolean };
}

/**
 * The next-page notice, from the rows the budget kept: after the budget drops the tail of a page, the next page has
 * to start after the last row shown, or the dropped rows are never read.
 */
function nextPageNotice(built: Built, kept: readonly Record<string, unknown>[]): QueryWarning[] {
  if (built.nextPage === undefined || kept.length === 0) return [];
  const { limit, afterGiven } = built.nextPage;
  return [
    {
      message: `More objects may follow: ${afterGiven ? "set after" : "add &after"}=${String(kept[kept.length - 1].$id)} to read the next ${limit}.`,
    },
  ];
}

function result(built: Built, options: WeaviateResultOptions): QueryResult {
  const { kept, warning } = budgeted(built.rows, options);
  // A result always names a column, so an empty answer still shows what it would have held.
  const fields = built.fields.length === 0 ? ["$id"] : [...built.fields];
  const rows = kept.map((row) => {
    const ordered: Record<string, unknown> = Object.create(null);
    for (const field of fields) ordered[field] = Object.hasOwn(row, field) ? row[field] : null;
    return ordered;
  });
  const notices = [...built.warnings, ...nextPageNotice(built, kept)];
  const warnings = warning === undefined ? notices : [...notices, warning];
  return {
    rows,
    fields,
    rowCount: rows.length,
    executionTime: options.executionTime,
    columnTypes: { ...built.columnTypes },
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(built.vectorColumns === undefined || Object.keys(built.vectorColumns).length === 0
      ? {}
      : { vectorColumns: built.vectorColumns }),
    ...(warning === undefined
      ? {}
      : {
          pagination: { limit: rows.length, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: true },
        }),
  };
}

/** Rows of a list of objects, one column per top-level key, in first-seen order: the metadata reads. */
function listRows(
  items: readonly Json[],
  options: WeaviateResultOptions,
  warnings: readonly QueryWarning[],
): QueryResult {
  const notes = new Notes();
  const fields = new Set<string>();
  const rows = items.map((item) => {
    if (!isObject(item)) throw new QueryError("Weaviate answered with no object where one was expected.", PROVIDER);
    const row: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item)) {
      fields.add(key);
      row[key] = notes.cell(item[key]);
    }
    return row;
  });
  return result({ fields: [...fields], rows, columnTypes: {}, warnings: [...warnings, ...notes.warnings()] }, options);
}

const OBJECT_TIMES: readonly (readonly [string, string])[] = [
  ["creationTimeUnix", "$creationTime"],
  ["lastUpdateTimeUnix", "$lastUpdateTime"],
];

/** One object of `GET /v1/objects` or `GET /v1/objects/{c}/{id}` as a row: id, properties, vectors, times. */
function objectRow(
  object: Json,
  notes: Notes,
  columns: { readonly properties: Set<string>; readonly vectors: Map<string, number> },
): Record<string, unknown> {
  if (!isObject(object) || typeof object.id !== "string") {
    throw new QueryError("Weaviate answered an object with no id.", PROVIDER);
  }
  const row: Record<string, unknown> = Object.create(null);
  row.$id = object.id;
  if (isObject(object.properties)) {
    for (const key of Object.keys(object.properties)) {
      columns.properties.add(key);
      row[key] = notes.cell(object.properties[key]);
    }
  }
  const vector = (name: string, value: Json | undefined) => {
    if (!Array.isArray(value)) return;
    const column = vectorColumnName(name);
    columns.vectors.set(column, value.length);
    row[column] = value;
  };
  if (Array.isArray(object.vector) && object.vector.length > 0) vector("", object.vector);
  if (isObject(object.vectors)) for (const name of Object.keys(object.vectors)) vector(name, object.vectors[name]);
  for (const [key, column] of OBJECT_TIMES) {
    if (typeof object[key] === "number") row[column] = object[key];
  }
  return row;
}

function objectRows(objects: readonly Json[], shape: WeaviateResultShape, options: WeaviateResultOptions): QueryResult {
  const notes = new Notes();
  const columns = { properties: new Set<string>(), vectors: new Map<string, number>() };
  const rows = objects.map((object) => objectRow(object, notes, columns));
  const declared = shape.facts?.plainProperties ?? [];
  const properties = [...declared.filter((name) => columns.properties.has(name))];
  for (const name of columns.properties) if (!properties.includes(name)) properties.push(name);
  const times = OBJECT_TIMES.map(([, column]) => column).filter((column) =>
    rows.some((row) => Object.hasOwn(row, column)),
  );
  const vectorColumns: Record<string, VectorColumn> = {};
  for (const [column, dimension] of columns.vectors)
    vectorColumns[column] = { kind: "dense", dtype: "float32", dimension };
  const warnings = [...shape.warnings, ...notes.warnings()];
  return result(
    {
      fields: ["$id", ...properties, ...columns.vectors.keys(), ...times],
      rows,
      columnTypes: {
        $id: "uuid",
        ...(times.length === 0 ? {} : Object.fromEntries(times.map((t) => [t, "epoch ms"]))),
      },
      warnings,
      vectorColumns,
      // A full page says more may follow; result() writes the notice from the rows it keeps (see nextPageNotice).
      ...(shape.op === "objects" && shape.limit !== null && rows.length === shape.limit && rows.length > 0
        ? { nextPage: { limit: shape.limit, afterGiven: shape.afterGiven === true } }
        : {}),
    },
    options,
  );
}

/** A search hit as its id, its properties and its metadata, read from either path's answer. */
interface Hit {
  readonly id: string;
  readonly properties: JsonObject;
  readonly metadata: JsonObject;
}

function restHits(answer: Json): readonly Hit[] {
  const results = isObject(answer) ? answer.results : undefined;
  return listOf(results, "results").map((entry) => {
    if (!isObject(entry) || typeof entry.id !== "string")
      throw new QueryError("Weaviate answered a result with no id.", PROVIDER);
    return {
      id: entry.id,
      properties: isObject(entry.properties) ? entry.properties : {},
      metadata: isObject(entry.metadata) ? entry.metadata : {},
    };
  });
}

/** GraphQL's `data.Get.<Class>` as hits: `_additional` is the metadata, the rest the properties. */
/**
 * GraphQL answers the two times as integer strings and the BM25 and hybrid score as a decimal string, where REST
 * answers numbers, so the same search shows the same cell types on both paths (spec 5.6).
 */
function graphqlMetadataValue(rest: string, value: Json): Json {
  if (typeof value !== "string") return value;
  if (rest.endsWith("Time") && /^[0-9]+$/.test(value)) return Number(value);
  if (rest === "score" && /^-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/.test(value)) return Number(value);
  return value;
}

function graphqlHits(answer: Json, collection: string): readonly Hit[] {
  const data = isObject(answer) && isObject(answer.data) ? answer.data : undefined;
  const get = data !== undefined && isObject(data.Get) ? data.Get : undefined;
  return listOf(get?.[collection], "results").map((entry) => {
    if (!isObject(entry) || !isObject(entry._additional) || typeof entry._additional.id !== "string") {
      throw new QueryError("Weaviate answered a result with no id.", PROVIDER);
    }
    const { _additional: additional, ...properties } = entry;
    const metadata: Record<string, Json> = {};
    for (const [rest, graphql] of Object.entries(GRAPHQL_METADATA)) {
      const value = (additional as JsonObject)[graphql];
      if (value === undefined) continue;
      metadata[rest] = graphqlMetadataValue(rest, value);
    }
    return { id: additional.id as string, properties, metadata };
  });
}

const METADATA_TYPES: Readonly<Record<string, string>> = {
  distance: "distance, lower is closer",
  certainty: "certainty, higher is closer",
  score: "score, higher is better",
  explainScore: "text",
  creationTime: "epoch ms",
  lastUpdateTime: "epoch ms",
};

function searchRows(answer: Json, shape: WeaviateResultShape, options: WeaviateResultOptions): QueryResult {
  const model = shape.model as WeaviateSearchModel;
  const facts = shape.facts as WeaviateCollectionFacts;
  const hits = shape.path === "graphql" ? graphqlHits(answer, model.collection) : restHits(answer);
  const notes = new Notes();
  const properties = [...(model.returnProperties ?? facts.plainProperties)];
  for (const hit of hits)
    for (const key of Object.keys(hit.properties)) if (!properties.includes(key)) properties.push(key);
  const metadata = model.returnMetadata.map((word) => `$${word}`);
  const rows = hits.map((hit) => {
    const row: Record<string, unknown> = Object.create(null);
    row.$id = hit.id;
    for (const name of properties) {
      const value = hit.properties[name];
      if (shape.path === "graphql" && value === null && facts.intProperties.has(name)) notes.int32Nulls.add(name);
      row[name] = notes.cell(value);
    }
    for (const word of model.returnMetadata) row[`$${word}`] = notes.cell(hit.metadata[word]);
    return row;
  });
  const warnings = [...shape.warnings, ...notes.warnings()];
  const vector = facts.vectors.find((entry) => entry.name === (model.targetVector ?? ""));
  if (rows.length === 0 && model.op === "search_near_vector" && vector !== undefined && vector.quantization !== null) {
    warnings.push({
      message: `No results. The vector index is ${vector.quantization}-compressed, and Weaviate answers an empty result rather than an error when a query vector's length differs from the stored vectors', so check the vector's length.`,
    });
  }
  return result(
    {
      fields: ["$id", ...properties, ...metadata],
      rows,
      columnTypes: {
        $id: "uuid",
        ...Object.fromEntries(model.returnMetadata.map((word) => [`$${word}`, METADATA_TYPES[word]])),
      },
      warnings,
    },
    options,
  );
}

/** An aggregate's group limit as a number: written by phase 0 for every groupBy, an integer phase 0 has checked. */
function groupBound(model: WeaviateSearchModel): number | null {
  const limit = model.limit as { readonly digits?: string } | null;
  return limit === null || typeof limit.digits !== "string" ? null : Number(limit.digits);
}

function aggregateRows(answer: Json, shape: WeaviateResultShape, options: WeaviateResultOptions): QueryResult {
  const model = shape.model as WeaviateSearchModel;
  const groups: { readonly value: Json; readonly count: Json }[] = [];
  let total: Json | undefined;
  if (shape.path === "graphql") {
    const data = isObject(answer) && isObject(answer.data) ? answer.data : undefined;
    const aggregate = data !== undefined && isObject(data.Aggregate) ? data.Aggregate : undefined;
    for (const entry of listOf(aggregate?.[model.collection], "aggregates")) {
      if (!isObject(entry)) continue;
      const count = isObject(entry.meta) ? entry.meta.count : null;
      if (model.groupBy === null) total = count;
      else groups.push({ value: isObject(entry.groupedBy) ? entry.groupedBy.value : null, count });
    }
  } else if (isObject(answer)) {
    if (model.groupBy === null) total = answer.count;
    else {
      for (const entry of listOf(answer.groups, "groups")) {
        if (!isObject(entry)) continue;
        groups.push({ value: isObject(entry.groupedBy) ? entry.groupedBy.value : null, count: entry.count });
      }
    }
  }
  const countType = countLabel("exact");
  if (model.groupBy === null) {
    if (typeof total !== "number") throw new QueryError("Weaviate answered an aggregate with no count.", PROVIDER);
    return result(
      {
        fields: ["count"],
        rows: [Object.assign(Object.create(null), { count: total })],
        columnTypes: { count: countType },
        warnings: shape.warnings,
      },
      options,
    );
  }
  const column = model.groupBy;
  const bound = groupBound(model);
  const reached =
    bound !== null && groups.length >= bound
      ? [
          {
            message: `Weaviate answered the ${bound} groups the limit allows; more may exist: raise limit (at most ${WEAVIATE_BOUNDS.maxRows}).`,
          },
        ]
      : [];
  return result(
    {
      fields: [column, "count"],
      rows: groups.map((group) => Object.assign(Object.create(null), { [column]: group.value, count: group.count })),
      columnTypes: { count: countType },
      warnings: [...shape.warnings, ...reached],
    },
    options,
  );
}

/** The answer of a request phase 1 accepted, as the result the grid shows. */
export function weaviateResult(text: string, shape: WeaviateResultShape, options: WeaviateResultOptions): QueryResult {
  const answer = parsed(text);
  const field = (key: string): Json | undefined => (isObject(answer) ? answer[key] : undefined);
  switch (shape.op) {
    case "meta":
    case "collection":
    case "tenant":
    case "alias":
      return listRows([answer], options, shape.warnings);
    case "schema":
      return listRows(listOf(field("classes"), "classes"), options, shape.warnings);
    case "shards":
    case "tenants":
      return listRows(listOf(answer, "entries"), options, shape.warnings);
    case "aliases":
      return listRows(listOf(field("aliases"), "aliases"), options, shape.warnings);
    case "nodes":
    case "collection_nodes":
      return listRows(listOf(field("nodes"), "nodes"), options, shape.warnings);
    case "objects":
      return objectRows(listOf(field("objects"), "objects"), shape, options);
    case "object":
      return objectRows([answer], shape, options);
    case "search_bm25":
    case "search_hybrid":
    case "search_near_vector":
    case "search_near_object":
      return searchRows(answer, shape, options);
    case "aggregate":
      return aggregateRows(answer, shape, options);
  }
}
