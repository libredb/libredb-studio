import { utf8ByteLength } from "@/lib/db/console/bounds";
import { QueryError } from "@/lib/db/errors";
import { countLabel } from "@/lib/db/vector/count";
import { nonFiniteScoreWarning, scoreCell, scoreColumnType } from "@/lib/db/vector/score";
import type { VectorColumn, VectorFieldInfo } from "@/lib/db/vector/types";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import type { QueryResult, QueryWarning } from "@/lib/types";
import { payloadColumnName, QDRANT_STUDIO_COLUMNS, renameWarning, vectorColumnName } from "./columns";
import { qdrantScoreSemantics, qdrantVectorColumn } from "./qdrant-vocabulary";
import type { QdrantResultShape } from "./request";
import { QDRANT_BOUNDS } from "./routes";

/**
 * A Qdrant answer to a `QueryResult`, by route: one row per point for retrieve, scroll and query, one per point of
 * each search for a batch (`$search` first), one per hit for a grouped query (`$group` first), the facet's own two
 * columns, and one row for a count and for each metadata read.
 *
 * The answer is parsed losslessly: `quoteUnsafeIntegers` first, so an integer above 2^53 stays its exact digits.
 * A point id is always its exact decimal text, never a JavaScript number. Rows are built on `Object.create(null)`,
 * so a payload key named `constructor` is an ordinary column. Conversion stops at the byte budget and drops the
 * rest whole; text cells are cut at their bound with a marker; vector cells are never cut.
 */

export interface QdrantResultOptions {
  readonly executionTime: number;
  /** The byte budget; only a test passes another. */
  readonly budgetBytes?: number;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** A value read from the answer beside the same value as a plain parse rounds it, to tell a quoted integer. */
interface Read {
  readonly exact: Json | undefined;
  readonly rounded: Json | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^-?[0-9]+$/;

/**
 * The answer's value: the body's `result`, or the whole body for `GET /`, which Qdrant answers with no envelope.
 * Only an answer that held an integer past 2^53 is parsed a second time, plainly, to tell a quoted integer from a
 * string.
 */
function parsed(text: string, envelope: boolean): Read {
  const quoted = quoteUnsafeIntegers(text);
  let body: Json;
  try {
    body = JSON.parse(quoted) as Json;
  } catch {
    throw new QueryError("Qdrant answered with a body that is not JSON.");
  }
  const read: Read = { exact: body, rounded: quoted === text ? undefined : (JSON.parse(text) as Json) };
  return envelope ? at(read, "result") : read;
}

function at(read: Read, key: string | number): Read {
  const step = (value: Json | undefined): Json | undefined =>
    value !== null && typeof value === "object" ? (value as Readonly<Record<string, Json>>)[key] : undefined;
  return { exact: step(read.exact), rounded: step(read.rounded) };
}

function list(read: Read, what: string): readonly Read[] {
  if (!Array.isArray(read.exact)) throw new QueryError(`Qdrant answered with no list of ${what}.`);
  return read.exact.map((_, index) => at(read, index));
}

/** Whether the value, at any depth, holds an integer the lossless parse kept as digits. */
function holdsQuoted(read: Read): boolean {
  const { exact, rounded } = read;
  if (rounded === undefined) return false;
  if (typeof exact === "string") return typeof rounded === "number";
  if (exact === null || typeof exact !== "object") return false;
  return Object.keys(exact).some((key) => holdsQuoted(at(read, Array.isArray(exact) ? Number(key) : key)));
}

/** The notes a conversion gathers, written as warnings once it ends. */
class Notes {
  readonly renames = new Map<string, string>();
  readonly quotedColumns = new Set<string>();
  readonly overflowColumns = new Map<string, number>();
  reconstructed = new Set<string>();
  cutCells = 0;
  nonFinite = 0;

  text(value: string): string {
    const limit = QDRANT_BOUNDS.stringCellUnits;
    if (value.length <= limit) return value;
    const high = value.charCodeAt(limit - 1);
    const end = high >= 0xd800 && high <= 0xdbff ? limit - 1 : limit;
    this.cutCells += 1;
    return `${value.slice(0, end)}...[cut: ${end} of ${value.length} characters shown]`;
  }

  warnings(): QueryWarning[] {
    const warnings: QueryWarning[] = [];
    const renamed = renameWarning(this.renames);
    if (renamed !== undefined) warnings.push(renamed);
    if (this.quotedColumns.size > 0) {
      warnings.push({
        message: `Integers above 2^53 in ${[...this.quotedColumns].join(", ")} are shown as their exact digits, because a JavaScript number would round them.`,
      });
    }
    for (const [column, cells] of this.overflowColumns) {
      warnings.push({
        message: `${cells} cells of ${column} hold null elements: Qdrant stores a float16 element that overflowed as infinity and answers it as null.`,
      });
    }
    for (const column of this.reconstructed) {
      warnings.push({
        message: `${column} is stored as turbo4: Qdrant answers a 4-bit reconstruction, not the vector that was written.`,
      });
    }
    if (this.cutCells > 0) {
      warnings.push({
        message: `${this.cutCells} text cells were longer than ${QDRANT_BOUNDS.stringCellUnits} characters and are cut, with a marker.`,
      });
    }
    if (this.nonFinite > 0) warnings.push(nonFiniteScoreWarning(this.nonFinite));
    return warnings;
  }
}

/** A cell for a JSON value: a top-level string is cut at its bound, and an integer kept as digits noted. */
function cell(read: Read, column: string, notes: Notes): Json {
  if (read.exact === undefined) return null;
  if (holdsQuoted(read)) notes.quotedColumns.add(column);
  return typeof read.exact === "string" ? notes.text(read.exact) : read.exact;
}

/** A point id as its exact decimal text, or a UUID as the server wrote it. */
function pointId(read: Read): string {
  const { exact } = read;
  if (typeof exact === "number" && Number.isSafeInteger(exact)) return String(exact);
  if (typeof exact === "string" && (DIGITS.test(exact) || UUID.test(exact))) return exact;
  throw new QueryError("Qdrant answered a point whose id is neither an unsigned integer nor a UUID.");
}

interface PointColumns {
  readonly vectors: Map<string, VectorFieldInfo | null>;
  readonly payload: Set<string>;
  orderValue: boolean;
  shardKey: boolean;
}

/** A point of an answer as a row: id, score, vectors, order value, shard key and payload. */
function pointRow(
  point: Read,
  shape: QdrantResultShape,
  columns: PointColumns,
  notes: Notes,
  scored: boolean,
): Record<string, unknown> {
  const cells: Record<string, unknown> = Object.create(null);
  cells.id = pointId(at(point, "id"));
  if (scored) {
    const raw = at(point, "score").exact;
    const score = scoreCell(typeof raw === "number" ? raw : null);
    if (typeof score === "string") notes.nonFinite += 1;
    cells.score = score;
  }
  const vector = at(point, "vector");
  if (vector.exact !== undefined && vector.exact !== null) {
    const unnamed = Array.isArray(vector.exact);
    const entries: [string, Json][] = unnamed
      ? [["", vector.exact as Json]]
      : Object.entries(vector.exact as Readonly<Record<string, Json>>);
    for (const [name, value] of entries) {
      const column = vectorColumnName(name);
      const field = shape.facts?.vectors.find((entry) => entry.name === name) ?? null;
      columns.vectors.set(column, field);
      if (shape.facts?.reconstructed.has(name) === true) notes.reconstructed.add(column);
      if (Array.isArray(value) && value.includes(null)) {
        notes.overflowColumns.set(column, (notes.overflowColumns.get(column) ?? 0) + 1);
      }
      cells[column] = value;
    }
  }
  const orderValue = at(point, "order_value");
  if (orderValue.exact !== undefined) {
    columns.orderValue = true;
    cells.order_value = cell(orderValue, "order_value", notes);
  }
  const shardKey = at(point, "shard_key");
  if (shardKey.exact !== undefined) {
    columns.shardKey = true;
    cells.shard_key = cell(shardKey, "shard_key", notes);
  }
  const payload = at(point, "payload");
  if (payload.exact !== null && typeof payload.exact === "object" && !Array.isArray(payload.exact)) {
    for (const key of Object.keys(payload.exact)) {
      const column = payloadColumnName(key);
      if (column !== key) notes.renames.set(key, column);
      columns.payload.add(column);
      cells[column] = cell(at(payload, key), column, notes);
    }
  }
  return cells;
}

/** The rows within the byte budget, whole; the rest dropped, with `wasLimited` and a warning naming the bound. */
function budgeted(
  rows: readonly Record<string, unknown>[],
  options: QdrantResultOptions,
): { readonly kept: readonly Record<string, unknown>[]; readonly warning?: QueryWarning } {
  const budget = options.budgetBytes ?? QDRANT_BOUNDS.resultBudgetBytes;
  let bytes = 0;
  for (let index = 0; index < rows.length; index++) {
    bytes += utf8ByteLength(JSON.stringify(rows[index]));
    if (bytes > budget) {
      const bound = budget >= 1_048_576 ? `${budget / 1_048_576} MiB` : `${budget}-byte`;
      return {
        kept: rows.slice(0, index),
        warning: {
          message: `The result reached Studio's ${bound} result budget after ${index} rows; the remaining ${rows.length - index} rows are not shown. Lower "limit", or set "with_vector" to false or to the vectors you need.`,
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
}

function result(built: Built, options: QdrantResultOptions): QueryResult {
  const { kept, warning } = budgeted(built.rows, options);
  const fields = [...built.fields];
  const rows = kept.map((row) => {
    const ordered: Record<string, unknown> = Object.create(null);
    for (const field of fields) ordered[field] = Object.hasOwn(row, field) ? row[field] : null;
    return ordered;
  });
  const warnings = warning === undefined ? [...built.warnings] : [...built.warnings, warning];
  return {
    rows,
    fields,
    rowCount: rows.length,
    executionTime: options.executionTime,
    columnTypes: { ...built.columnTypes },
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(built.vectorColumns === undefined ? {} : { vectorColumns: built.vectorColumns }),
    ...(warning === undefined
      ? {}
      : {
          pagination: { limit: rows.length, offset: 0, hasMore: false, totalReturned: rows.length, wasLimited: true },
        }),
  };
}

/** The score column's text: one label when every search means the same, else a pointer to the notice lines. */
function scoreTypes(shape: QdrantResultShape): { readonly text: string; readonly notices: readonly QueryWarning[] } {
  const vectors = shape.facts?.vectors ?? [];
  const labels = shape.searches.map((search) => scoreColumnType(qdrantScoreSemantics(search, vectors)));
  const distinct = [...new Set(labels)];
  if (distinct.length === 1) return { text: distinct[0], notices: [] };
  return {
    text: "varies by search, see the result notice",
    notices: distinct.map((label) => ({
      message: `Score in search ${labels.flatMap((entry, index) => (entry === label ? [index] : [])).join(", ")}: ${label}.`,
    })),
  };
}

/** One row of a point result: the point, or null for a group with no hits, after the columns Studio adds. */
interface PointEntry {
  readonly point: Read | null;
  readonly lead: Readonly<Record<string, unknown>>;
}

/** Points to rows with their columns, in the order a point result shows them. */
function points(
  entries: readonly PointEntry[],
  shape: QdrantResultShape,
  lead: readonly string[],
  leadTypes: Readonly<Record<string, string>>,
  scored: boolean,
  options: QdrantResultOptions,
  extra: readonly QueryWarning[],
): QueryResult {
  const notes = new Notes();
  const columns: PointColumns = { vectors: new Map(), payload: new Set(), orderValue: false, shardKey: false };
  const all = entries.map(({ point, lead: leading }) => {
    const row = point === null ? {} : pointRow(point, shape, columns, notes, scored);
    return Object.assign(Object.create(null), leading, row) as Record<string, unknown>;
  });
  const score = scored ? scoreTypes(shape) : { text: "", notices: [] };
  // The collection's own order, as the tree lists its vectors; a vector the description does not name goes last.
  const declared = (shape.facts?.vectors ?? []).map((field) => vectorColumnName(field.name));
  const position = (column: string) => (declared.includes(column) ? declared.indexOf(column) : declared.length);
  const vectorFields = [...columns.vectors.keys()].sort((a, b) => position(a) - position(b));
  const fields = [
    ...lead,
    "id",
    ...(scored ? ["score"] : []),
    ...vectorFields,
    ...(columns.orderValue ? ["order_value"] : []),
    ...(columns.shardKey ? ["shard_key"] : []),
    ...columns.payload,
  ];
  const columnTypes: Record<string, string> = { ...leadTypes, id: "uint64 or UUID" };
  if (scored) columnTypes.score = score.text;
  const vectorColumns: Record<string, VectorColumn> = {};
  for (const [column, field] of columns.vectors) {
    if (field === null) continue;
    columnTypes[column] = field.nativeType;
    vectorColumns[column] = qdrantVectorColumn(field);
  }
  for (const column of columns.payload) {
    const key = [...notes.renames].find(([, renamed]) => renamed === column)?.[0] ?? column;
    columnTypes[column] = shape.facts?.payloadIndexTypes.get(key) ?? "payload";
  }
  return result(
    {
      fields,
      rows: all,
      columnTypes,
      warnings: [...shape.warnings, ...score.notices, ...extra, ...notes.warnings()],
      ...(Object.keys(vectorColumns).length === 0 ? {} : { vectorColumns }),
    },
    options,
  );
}

/** The warning that carries a scroll's next page: the exact offset to repeat the request with. */
function nextPageWarning(read: Read): QueryWarning | undefined {
  const { exact } = read;
  if (exact === undefined || exact === null) return undefined;
  const written = typeof exact === "string" && UUID.test(exact) ? JSON.stringify(exact) : pointId(read);
  return {
    code: "next_page_offset",
    message: `The scroll has more points. Its next_page_offset is ${written}: repeat the request with "offset": ${written} in the body to read the next page.`,
  };
}

/** A group's id as the answer's JSON value: a string stays a string, an integer past 2^53 keeps its digits. */
function groupId(read: Read, notes: { quoted: boolean; kinds: Map<string, Set<string>> }): unknown {
  const { exact } = read;
  if (typeof exact === "string" && holdsQuoted(read)) notes.quoted = true;
  const text = String(exact);
  const kind = typeof exact === "string" && !holdsQuoted(read) ? "string" : "integer";
  if (!notes.kinds.has(text)) notes.kinds.set(text, new Set());
  notes.kinds.get(text)?.add(kind);
  return exact;
}

/** One row of the answer's keys, every value a cell. */
function objectRow(read: Read, notes: Notes): { readonly fields: string[]; readonly row: Record<string, unknown> } {
  if (read.exact === null || typeof read.exact !== "object" || Array.isArray(read.exact)) {
    throw new QueryError("Qdrant answered with no object where one was expected.");
  }
  const row: Record<string, unknown> = Object.create(null);
  const fields = Object.keys(read.exact);
  for (const key of fields) row[key] = cell(at(read, key), key, notes);
  return { fields, row };
}

/** Rows of a list of objects, the columns in first-seen order. */
function listRows(items: readonly Read[], options: QdrantResultOptions): QueryResult {
  const notes = new Notes();
  const fields = new Set<string>();
  const rows = items.map((item) => {
    const read = objectRow(item, notes);
    for (const field of read.fields) fields.add(field);
    return read.row;
  });
  return result({ fields: [...fields], rows, columnTypes: {}, warnings: notes.warnings() }, options);
}

function oneRow(read: Read, options: QdrantResultOptions): QueryResult {
  return listRows([read], options);
}

/** The answer of a request phase 1 accepted, as the result the grid shows. */
export function qdrantResult(text: string, shape: QdrantResultShape, options: QdrantResultOptions): QueryResult {
  const answer = parsed(text, shape.op !== "root");
  switch (shape.op) {
    case "root":
    case "get_collection":
    case "collection_exists":
    case "get_optimizations":
    case "collection_cluster_info":
      return oneRow(answer, options);
    case "get_collections":
      return listRows(list(at(answer, "collections"), "collections"), options);
    case "get_collections_aliases":
    case "get_collection_aliases":
      return listRows(list(at(answer, "aliases"), "aliases"), options);
    case "list_snapshots":
      return listRows(list(answer, "snapshots"), options);
    case "count_points": {
      const count = at(answer, "count");
      if (typeof count.exact !== "number" && typeof count.exact !== "string") {
        throw new QueryError("Qdrant answered a count with no number.");
      }
      return result(
        {
          fields: ["count"],
          rows: [Object.assign(Object.create(null), { count: count.exact })],
          columnTypes: { count: countLabel(shape.exact ? "exact" : "estimate") },
          warnings: shape.warnings,
        },
        options,
      );
    }
    case "facet": {
      const notes = new Notes();
      const rows = list(at(answer, "hits"), "facet hits").map((hit) =>
        Object.assign(Object.create(null), {
          value: cell(at(hit, "value"), "value", notes),
          count: at(hit, "count").exact,
        }),
      );
      return result(
        {
          fields: ["value", "count"],
          rows,
          columnTypes: { value: "string, integer or boolean", count: countLabel(shape.exact ? "exact" : "estimate") },
          warnings: [...shape.warnings, ...notes.warnings()],
        },
        options,
      );
    }
    case "get_point":
      return points([{ point: answer, lead: {} }], shape, [], {}, false, options, []);
    case "get_points":
      return points(
        list(answer, "points").map((point) => ({ point, lead: {} })),
        shape,
        [],
        {},
        false,
        options,
        [],
      );
    case "scroll_points": {
      const next = nextPageWarning(at(answer, "next_page_offset"));
      return points(
        list(at(answer, "points"), "points").map((point) => ({ point, lead: {} })),
        shape,
        [],
        {},
        false,
        options,
        next === undefined ? [] : [next],
      );
    }
    case "query_points":
      return points(
        list(at(answer, "points"), "points").map((point) => ({ point, lead: {} })),
        shape,
        [],
        {},
        true,
        options,
        [],
      );
    case "query_batch_points": {
      const searches = list(answer, "searches");
      if (searches.length !== shape.searches.length) {
        throw new QueryError(
          `Qdrant answered ${searches.length} searches to a batch of ${shape.searches.length}, so its rows cannot be told apart.`,
        );
      }
      const empty: QueryWarning[] = [];
      const rows = searches.flatMap((search, index) => {
        const found = list(at(search, "points"), "points");
        if (found.length === 0) empty.push({ message: `search ${index} returned no points` });
        return found.map((point) => ({ point, lead: { [QDRANT_STUDIO_COLUMNS.search]: index } }));
      });
      return points(
        rows,
        shape,
        [QDRANT_STUDIO_COLUMNS.search],
        { $search: "index into searches" },
        true,
        options,
        empty,
      );
    }
    case "query_points_groups": {
      const groupNotes = { quoted: false, kinds: new Map<string, Set<string>>() };
      const rows: PointEntry[] = [];
      let lookups = false;
      for (const group of list(at(answer, "groups"), "groups")) {
        const id = groupId(at(group, "id"), groupNotes);
        const lookup = at(group, "lookup");
        if (lookup.exact !== undefined) lookups = true;
        const leadOf = (first: boolean) => ({
          [QDRANT_STUDIO_COLUMNS.group]: id,
          ...(lookup.exact === undefined ? {} : { [QDRANT_STUDIO_COLUMNS.lookup]: first ? lookup.exact : null }),
        });
        const hits = list(at(group, "hits"), "hits");
        if (hits.length === 0) rows.push({ point: null, lead: leadOf(true) });
        hits.forEach((point, index) => {
          rows.push({ point, lead: leadOf(index === 0) });
        });
      }
      const extra: QueryWarning[] = [];
      if (groupNotes.quoted) {
        extra.push({
          message:
            "Group ids above 2^53 in $group are shown as their exact digits, because a JavaScript number would round them.",
        });
      }
      const mixed = [...groupNotes.kinds].filter(([, kinds]) => kinds.size > 1).map(([value]) => value);
      if (mixed.length > 0) {
        extra.push({
          message: `$group holds both a string and an integer written ${mixed.slice(0, 5).join(", ")}: they are different groups.`,
        });
      }
      const lead = lookups
        ? [QDRANT_STUDIO_COLUMNS.group, QDRANT_STUDIO_COLUMNS.lookup]
        : [QDRANT_STUDIO_COLUMNS.group];
      return points(
        rows,
        shape,
        lead,
        { $group: "string or integer", ...(lookups ? { $lookup: "lookup record" } : {}) },
        true,
        options,
        extra,
      );
    }
  }
}
