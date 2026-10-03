/**
 * Milvus answers to `QueryResult`s (vector-family spec 5.5, 5.6). Pure.
 *
 * Columns follow the DescribeCollection field order, never `fields_data`'s, which the server reorders on every call
 * (R09 F23). The dynamic field becomes one column per key by the merge rule of 5.5: static columns first, dynamic
 * keys in first-seen order, a static name always winning its own name, and every name allocated once, so the same
 * answer gives the same grid whatever order the server sent its columns in (R40 M19, R51 U14m). A search adds
 * `$query` when it asks more than one query, the `distance` column with the text of 3.3, and `$group` for a grouped
 * search. Conversion stops at the byte budget, dropping the remaining rows whole (5.6).
 */
import { utf8ByteLength } from "@/lib/db/console/bounds";
import { QueryError } from "@/lib/db/errors";
import { countLabel } from "@/lib/db/vector/count";
import { nonFiniteScoreWarning, scoreCell } from "@/lib/db/vector/score";
import type { VectorColumn } from "@/lib/db/vector/types";
import type { QueryResult, QueryWarning } from "@/lib/types";
import type { QueryResults, SearchResults, WireCollectionSchema } from "./client";
import { type ColumnReader, cutString, DecodeNotes, type DynamicCell, readColumn } from "./field-data";
import { fieldTypeText, scoreColumnText } from "./milvus-vocabulary";
import { type RowShape, type SearchShape, vectorTargetOf } from "./request";
import { MILVUS_BOUNDS } from "./routes";

const PROVIDER = "milvus" as const;

export interface ResultOptions {
  readonly executionTime: number;
  /** The byte budget of 5.6; only a test passes another. */
  readonly budgetBytes?: number;
}

/** A column with a name and a type text, read by row. */
interface Column {
  readonly name: string;
  readonly typeText: string;
  readonly vector?: VectorColumn;
  cell(row: number): unknown;
}

function malformed(detail: string): QueryError {
  return new QueryError(`Milvus returned an answer Studio cannot read: ${detail}.`, PROVIDER);
}

/** The vector declaration of a described field, for `QueryResult.vectorColumns` (3.10). */
function vectorColumnOf(field: WireCollectionSchema["fields"][number]): VectorColumn | undefined {
  const target = vectorTargetOf(field);
  if (target === undefined || target.kind === "multi") return undefined;
  return target.kind === "sparse"
    ? { kind: "sparse", dtype: target.dtype, dimension: null, sparseEncoding: "index-map" }
    : { kind: target.kind, dtype: target.dtype, dimension: target.dimension };
}

/** The static columns of an answer in schema order, then any column the description did not list, by name. */
function staticColumns(schema: WireCollectionSchema, readers: readonly ColumnReader[]): Column[] {
  const byName = new Map(readers.filter((reader) => !reader.isDynamic).map((reader) => [reader.name, reader]));
  const columns: Column[] = [];
  const take = (name: string, typeText: string, vector?: VectorColumn) => {
    const reader = byName.get(name);
    if (reader === undefined) return;
    byName.delete(name);
    columns.push({ name, typeText, ...(vector === undefined ? {} : { vector }), cell: (row) => reader.cell(row) });
  };
  for (const field of schema.fields) {
    if (!field.is_dynamic) take(field.name, fieldTypeText(field, schema.functions), vectorColumnOf(field));
  }
  for (const struct of schema.struct_array_fields) take(struct.name, "ArrayOfStruct");
  for (const name of [...byName.keys()].sort()) take(name, byName.get(name)?.type ?? "");
  return columns;
}

function sameLength(lengths: readonly number[], what: string): number {
  const length = lengths[0] ?? 0;
  if (lengths.some((other) => other !== length)) throw malformed(`${what} of different lengths`);
  return length;
}

interface Assembly {
  readonly rows: number;
  readonly leading: readonly Column[];
  readonly statics: readonly Column[];
  readonly trailing: readonly Column[];
  readonly dynamic: ColumnReader | undefined;
  readonly notes: DecodeNotes;
  readonly warnings: readonly QueryWarning[];
  readonly pagination: { readonly limit: number; readonly offset: number };
  readonly options: ResultOptions;
}

/** A budget as the warning names it: in MiB, or in bytes below one. */
function budgetText(bytes: number): string {
  return bytes >= 1_048_576 ? `${Math.round((bytes / 1_048_576) * 10) / 10} MiB` : `${bytes}-byte`;
}

/** Rows within the budget, the dynamic keys merged by the rule of 5.5, every name allocated once. */
function assemble(input: Assembly): QueryResult {
  const budget = input.options.budgetBytes ?? MILVUS_BOUNDS.resultBudgetBytes;
  const fixed = [...input.leading, ...input.statics, ...input.trailing];
  const kept: { readonly values: readonly unknown[]; readonly dynamic: DynamicCell | null }[] = [];
  let bytes = 0;
  for (let row = 0; row < input.rows; row += 1) {
    const values = fixed.map((column) => column.cell(row));
    const dynamic = (input.dynamic?.cell(row) ?? null) as DynamicCell | null;
    const size = utf8ByteLength(JSON.stringify([values, dynamic?.entries ?? null]));
    if (bytes + size > budget) break;
    bytes += size;
    kept.push({ values, dynamic });
  }
  const mergeWarnings: QueryWarning[] = [];

  const staticNames = new Set(input.statics.map((column) => column.name));
  const taken = new Set(fixed.map((column) => column.name));
  const dynamicNames = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const { dynamic } of kept) {
    for (const key of dynamic?.duplicates ?? []) duplicates.add(key);
    for (const [key] of dynamic?.entries ?? []) {
      if (dynamicNames.has(key)) continue;
      const shadowed = staticNames.has(key);
      const candidate = shadowed ? `$meta.${key}` : key;
      let name = candidate;
      for (let suffix = 2; taken.has(name); suffix += 1) name = `${candidate} (${suffix})`;
      taken.add(name);
      dynamicNames.set(key, name);
      if (shadowed) {
        mergeWarnings.push({
          message: `The dynamic key ${key} is shadowed by the static field of the same name: it is shown as ${name}, and only $meta["${key}"] in a filter reaches the dynamic value.`,
        });
      } else if (name !== key) {
        mergeWarnings.push({
          message: `The dynamic key ${key} is shown as ${name}, because another column has its name.`,
        });
      }
    }
  }
  for (const key of duplicates) {
    mergeWarnings.push({
      message: `A row's dynamic field repeats the key ${key}; Studio shows its last value, as JSON reading does.`,
    });
  }

  const rows = kept.map(({ values, dynamic }) => {
    const row: Record<string, unknown> = Object.create(null);
    fixed.forEach((column, index) => {
      row[column.name] = values[index];
    });
    for (const [key, value] of dynamic?.entries ?? []) {
      row[dynamicNames.get(key) as string] = typeof value === "string" ? cutString(value, input.notes) : value;
    }
    return row;
  });
  // Read after the rows are built, which cut dynamic strings too.
  const warnings: QueryWarning[] = [...input.notes.warnings(), ...input.warnings, ...mergeWarnings];

  const columnTypes: Record<string, string> = {};
  const vectorColumns: Record<string, VectorColumn> = {};
  for (const column of fixed) {
    columnTypes[column.name] = column.typeText;
    if (column.vector !== undefined) vectorColumns[column.name] = column.vector;
  }
  for (const name of dynamicNames.values()) columnTypes[name] = "dynamic";

  const limited = kept.length < input.rows;
  if (limited) {
    warnings.push({
      message: `The result reached Studio's ${budgetText(budget)} result budget after ${kept.length} rows; the remaining ${input.rows - kept.length} rows are not shown. Ask for fewer rows or fewer fields.`,
    });
  }
  return {
    rows,
    fields: [...fixed.map((column) => column.name), ...dynamicNames.values()],
    rowCount: rows.length,
    executionTime: input.options.executionTime,
    columnTypes,
    ...(Object.keys(vectorColumns).length === 0 ? {} : { vectorColumns }),
    ...(warnings.length === 0 ? {} : { warnings }),
    ...(limited
      ? {
          pagination: {
            limit: input.pagination.limit,
            offset: input.pagination.offset,
            hasMore: false,
            totalReturned: rows.length,
            wasLimited: true,
          },
        }
      : {}),
  };
}

/** An entities/query or entities/get answer. */
export function queryResult(answer: QueryResults, shape: RowShape, options: ResultOptions): QueryResult {
  const notes = new DecodeNotes();
  const readers = answer.fields_data.map((fd) => readColumn(fd, notes));
  return assemble({
    rows: sameLength(
      readers.map((reader) => reader.length),
      "columns",
    ),
    leading: [],
    statics: staticColumns(shape.schema, readers),
    trailing: [],
    dynamic: readers.find((reader) => reader.isDynamic),
    notes,
    warnings: [],
    pagination: shape,
    options,
  });
}

/**
 * A metadata route's answer as named, typed columns (a database or collection listing, a description, statistics),
 * under the same byte budget; the caller maps the client's answer to rows.
 */
export function tableResult(
  columns: readonly { readonly name: string; readonly typeText: string }[],
  rows: readonly (readonly unknown[])[],
  options: ResultOptions,
): QueryResult {
  return assemble({
    rows: rows.length,
    leading: [],
    statics: columns.map((column, index) => ({ ...column, cell: (row: number) => rows[row][index] })),
    trailing: [],
    dynamic: undefined,
    notes: new DecodeNotes(),
    warnings: [],
    pagination: { limit: rows.length, offset: 0 },
    options,
  });
}

/** A lone count: one row, its Int64 as an exact string, labelled exact (3.3, 5.4). */
export function countResult(answer: QueryResults, options: ResultOptions): QueryResult {
  const value = answer.fields_data.find((fd) => fd.field_name === "count(*)")?.scalars?.long_data?.data[0];
  if (value === undefined) throw malformed("a count with no count(*) value");
  const row: Record<string, unknown> = Object.create(null);
  row["count(*)"] = value;
  return {
    rows: [row],
    fields: ["count(*)"],
    rowCount: 1,
    executionTime: options.executionTime,
    columnTypes: { "count(*)": countLabel("exact") },
  };
}

/** An entities/search or entities/hybrid_search answer. */
export function searchResult(answer: SearchResults, shape: SearchShape, options: ResultOptions): QueryResult {
  const data = answer.results;
  const notes = new DecodeNotes();
  const topks = (data?.topks ?? []).map(Number);
  const hits = topks.reduce((total, topk) => total + topk, 0);
  const ids = data?.ids?.int_id?.data ?? data?.ids?.str_id?.data ?? [];
  const scores = data?.scores ?? [];
  const queryOf = topks.flatMap((topk, query) => Array.from({ length: topk }, () => query));
  const key = shape.schema.fields.find((field) => field.is_primary_key);
  const readers = (data?.fields_data ?? [])
    .filter((fd) => fd.field_name !== key?.name)
    .map((fd) => readColumn(fd, notes));
  const idReader: ColumnReader = {
    name: key?.name ?? "id",
    type: key?.data_type ?? "",
    isDynamic: false,
    length: ids.length,
    cell: (row) => ids[row],
  };
  sameLength([hits, ids.length, scores.length, ...readers.map((reader) => reader.length)], "search columns");

  const statics = staticColumns(shape.schema, [idReader, ...readers]);
  const distanceName = statics.some((column) => column.name === "distance") ? "$distance" : "distance";
  const trailing: Column[] = [
    { name: distanceName, typeText: scoreColumnText(shape.score), cell: (row) => scoreCell(scores[row]) },
  ];
  const groups = data?.group_by_field_value ?? data?.group_by_field_values[0] ?? null;
  if (shape.groupingField !== undefined && groups !== null) {
    const reader = readColumn(groups, notes);
    trailing.push({
      name: "$group",
      typeText: fieldTypeText(shape.groupingField, shape.schema.functions),
      cell: (row) => reader.cell(row),
    });
  }
  const leading: Column[] = shape.nq > 1 ? [{ name: "$query", typeText: "Int32", cell: (row) => queryOf[row] }] : [];
  const warnings: QueryWarning[] = [];
  if (shape.score.kind === "unreadable") {
    warnings.push({
      message:
        "Studio could not read this collection's index (DescribeIndex needs the IndexDetail privilege), so the score column names no metric and the rows are in rank order.",
    });
  }
  const result = assemble({
    rows: hits,
    leading,
    statics,
    trailing,
    dynamic: readers.find((reader) => reader.isDynamic),
    notes,
    warnings,
    pagination: shape,
    options,
  });
  const nonFinite = result.rows.filter((row) => typeof row[distanceName] !== "number").length;
  if (nonFinite === 0) return result;
  return { ...result, warnings: [...(result.warnings ?? []), nonFiniteScoreWarning(nonFinite)] };
}
