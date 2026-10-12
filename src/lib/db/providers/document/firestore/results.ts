/**
 * Firestore answers into grid rows (spec 5.6): documents, aggregations, collection ids, document names and explain
 * metrics. Pure and browser-safe. Every document name and collection id an answer carries is checked against this
 * connection's database and the id rules before it is shown (spec S5), and a malformed answer is an explicit error.
 */
import { QueryError } from "@/lib/db/errors";
import type { VectorColumn } from "@/lib/db/vector/types";
import type { QueryResult } from "@/lib/types";
import type { ResultShape } from "./console/compile";
import { FIRESTORE_TYPE, LIMITS } from "./constants";
import { displayFieldPath, type FieldPathSegments, isDocumentId } from "./field-path";
import { compareUtf8, type FirestoreTarget, idRefusal, isDocumentPath, relativeSegments } from "./names";
import {
  decodeValue,
  type FirestoreTypeName,
  isVectorValue,
  type RestDocument,
  type RestValue,
  typeNameOf,
  vectorOf,
} from "./values";

export interface ShapedResult {
  readonly rows: Record<string, unknown>[];
  readonly fields: string[];
  readonly columnTypes?: Record<string, string>;
  readonly vectorColumns?: QueryResult["vectorColumns"];
  readonly warnings: string[];
}

const MISSING_NAMES_SHOWN = 20;

export const RESULT_SENTENCES = {
  notList: "Firestore answered a query with something other than a list of results",
  malformed: (what: string): string => `Firestore answered ${what} in a shape Studio does not read`,
  foreignName: (name: string): string =>
    `Firestore answered with a document outside this connection's database: ${name}`,
  notDocument: (name: string): string => `Firestore answered with a name that is not a document: ${name}`,
  columnCap: (count: number): string =>
    `This result has ${count} columns; Studio shows the first 500. Add .select(...) to choose them`,
  droppedIds: (count: number): string =>
    `Firestore listed ${count} collection ids that break Firestore's id rules; Studio left them out`,
  idCap: "More collection ids exist past the 10 pages of 1,000 ids Studio reads",
  moreDocuments: "Studio lists the first 100 documents; more exist. Query the collection to page through them",
  missingDocument: (path: string): string => `No document exists at ${path}`,
  missingDocuments: (paths: readonly string[]): string =>
    `Not found: ${paths.slice(0, MISSING_NAMES_SHOWN).join(", ")}${paths.length > MISSING_NAMES_SHOWN ? `, and ${paths.length - MISSING_NAMES_SHOWN} more` : ""}`,
  aggregationCount: (count: number): string =>
    `Firestore answered an aggregation with ${count} results; Studio expects one`,
  noPlan: "Firestore answered this explain request without a query plan",
  explainReturned: (count: number): string => `The explain run returned ${count} results`,
} as const;

interface Column {
  readonly name: string;
  readonly path: FieldPathSegments;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const malformed = (what: string): QueryError => new QueryError(RESULT_SENTENCES.malformed(what), FIRESTORE_TYPE);

function readDocument(value: unknown): RestDocument {
  if (!isRecord(value) || typeof value.name !== "string" || (value.fields !== undefined && !isRecord(value.fields))) {
    throw malformed("a document");
  }
  return value as unknown as RestDocument;
}

function relativeName(name: string, target: FirestoreTarget): string {
  const segments = relativeSegments(target, name);
  if (segments === null) throw new QueryError(RESULT_SENTENCES.foreignName(name), FIRESTORE_TYPE);
  if (!isDocumentPath(segments)) throw new QueryError(RESULT_SENTENCES.notDocument(name), FIRESTORE_TYPE);
  return segments.join("/");
}

/** The REST answer of runQuery and runAggregationQuery: an array of elements, some carrying no document. */
export function readQueryStream(json: unknown): {
  documents: RestDocument[];
  aggregates: Record<string, RestValue>[];
  explainMetrics?: unknown;
  skippedResults: number;
} {
  if (!Array.isArray(json)) throw new QueryError(RESULT_SENTENCES.notList, FIRESTORE_TYPE);
  const documents: RestDocument[] = [];
  const aggregates: Record<string, RestValue>[] = [];
  let explainMetrics: unknown;
  let skippedResults = 0;
  for (const element of json) {
    if (!isRecord(element)) throw new QueryError(RESULT_SENTENCES.notList, FIRESTORE_TYPE);
    if (element.document !== undefined) documents.push(readDocument(element.document));
    if (element.result !== undefined) {
      const fields = isRecord(element.result) ? (element.result.aggregateFields ?? {}) : undefined;
      if (!isRecord(fields)) throw malformed("an aggregation result");
      aggregates.push(fields as Record<string, RestValue>);
    }
    if (typeof element.skippedResults === "number") skippedResults += element.skippedResults;
    if (element.explainMetrics !== undefined) explainMetrics = element.explainMetrics;
  }
  return explainMetrics === undefined
    ? { documents, aggregates, skippedResults }
    : { documents, aggregates, explainMetrics, skippedResults };
}

function readPath(fields: RestDocument["fields"], path: FieldPathSegments): RestValue | undefined {
  let current: Readonly<Record<string, RestValue>> = fields ?? {};
  for (let index = 0; index < path.length - 1; index++) {
    const map = current[path[index]]?.mapValue;
    if (!isRecord(map)) return undefined;
    current = isRecord(map.fields) ? (map.fields as Record<string, RestValue>) : {};
  }
  return current[path[path.length - 1]];
}

function selectedColumns(select: readonly FieldPathSegments[]): Column[] {
  const columns = new Map<string, Column>();
  for (const path of select) {
    const name = displayFieldPath(path);
    if (!isDocumentId(path) && !columns.has(name)) columns.set(name, { name, path });
  }
  return [...columns.values()];
}

function unionColumns(documents: readonly RestDocument[]): Column[] {
  const names = new Set<string>();
  for (const document of documents) for (const name of Object.keys(document.fields ?? {})) names.add(name);
  return [...names].sort(compareUtf8).map((name) => ({ name, path: [name] }));
}

const typeText = (seen: ReadonlySet<FirestoreTypeName>): string => {
  const sorted = [...seen].sort(compareUtf8);
  return sorted.length === 1 ? sorted[0] : `mixed(${sorted.join("|")})`;
};

function documentRows(
  documents: readonly RestDocument[],
  select: readonly FieldPathSegments[] | undefined,
  target: FirestoreTarget,
): ShapedResult {
  const names = documents.map((document) => relativeName(document.name, target));
  const columns = select === undefined ? unionColumns(documents) : selectedColumns(select);
  const total = columns.length + 1;
  const kept = total > LIMITS.maxResultColumns ? columns.slice(0, LIMITS.maxResultColumns - 1) : columns;
  const warnings = kept.length < columns.length ? [RESULT_SENTENCES.columnCap(total)] : [];
  const types = new Map<string, Set<FirestoreTypeName>>();
  // A column's vector dimensions, or null once any value in it is not a vector.
  const dimensions = new Map<string, Set<number> | null>();
  const rows = documents.map((document, index) => {
    const row: Record<string, unknown> = { __name__: names[index] };
    for (const column of kept) {
      const value = readPath(document.fields, column.path);
      if (value === undefined) continue;
      row[column.name] = decodeValue(value, target);
      types.set(column.name, (types.get(column.name) ?? new Set<FirestoreTypeName>()).add(typeNameOf(value)));
      const vector = isVectorValue(value) ? vectorOf(value) : null;
      const seen = dimensions.get(column.name);
      if (vector === null) dimensions.set(column.name, null);
      else if (seen !== null) dimensions.set(column.name, (seen ?? new Set<number>()).add(vector.length));
    }
    return row;
  });
  const columnTypes: Record<string, string> = { __name__: "string" };
  for (const column of kept) {
    const seen = types.get(column.name);
    if (seen !== undefined) columnTypes[column.name] = typeText(seen);
  }
  const vectorColumns: Record<string, VectorColumn> = {};
  for (const [name, seen] of dimensions) {
    if (seen !== null && seen.size === 1)
      vectorColumns[name] = { kind: "dense", dtype: "float64", dimension: [...seen][0] };
  }
  return {
    rows,
    fields: ["__name__", ...kept.map((column) => column.name)],
    columnTypes,
    ...(Object.keys(vectorColumns).length === 0 ? {} : { vectorColumns }),
    warnings,
  };
}

function aggregationRows(
  json: unknown,
  keys: readonly { wire: string; user: string }[],
  target: FirestoreTarget,
): ShapedResult {
  const { aggregates } = readQueryStream(json);
  if (aggregates.length !== 1)
    throw new QueryError(RESULT_SENTENCES.aggregationCount(aggregates.length), FIRESTORE_TYPE);
  const row: Record<string, unknown> = {};
  const columnTypes: Record<string, string> = {};
  for (const key of keys) {
    const value = aggregates[0][key.wire];
    if (value === undefined) continue;
    row[key.user] = decodeValue(value, target);
    columnTypes[key.user] = typeNameOf(value);
  }
  return { rows: [row], fields: keys.map((key) => key.user), columnTypes, warnings: [] };
}

function collectionIdRows(json: unknown, parent: readonly string[]): ShapedResult {
  const listed = isRecord(json) ? (json.collectionIds ?? []) : undefined;
  if (!Array.isArray(listed) || listed.some((id) => typeof id !== "string")) throw malformed("a collection listing");
  // An id repeated across pages is listed once, as objects.ts's listCollectionIdsSorted lists it for the tree.
  const distinct = [...new Set(listed as string[])];
  const ids = distinct.filter((id) => idRefusal(id, "collection") === null).sort(compareUtf8);
  const warnings: string[] = [];
  if (ids.length < distinct.length) warnings.push(RESULT_SENTENCES.droppedIds(distinct.length - ids.length));
  if (isRecord(json) && typeof json.nextPageToken === "string" && json.nextPageToken !== "")
    warnings.push(RESULT_SENTENCES.idCap);
  return {
    rows: ids.map((id) => ({ id, path: [...parent, id].join("/") })),
    fields: ["id", "path"],
    columnTypes: { id: "string", path: "string" },
    warnings,
  };
}

function documentNameRows(json: unknown, target: FirestoreTarget): ShapedResult {
  const listed = isRecord(json) ? (json.documents ?? []) : undefined;
  if (!Array.isArray(listed)) throw malformed("a document listing");
  const rows = listed.map((element) => {
    const document = readDocument(element);
    return { __name__: relativeName(document.name, target), exists: typeof document.createTime === "string" };
  });
  const more = isRecord(json) && typeof json.nextPageToken === "string" && json.nextPageToken !== "";
  return {
    rows,
    fields: ["__name__", "exists"],
    columnTypes: { __name__: "string", exists: "boolean" },
    warnings: more ? [RESULT_SENTENCES.moreDocuments] : [],
  };
}

/** A batchGet answer as relative path to document, or to null when Firestore answered it missing. */
function readBatchGet(json: unknown, target: FirestoreTarget): Map<string, RestDocument | null> {
  if (!Array.isArray(json)) throw malformed("a document read");
  const answers = new Map<string, RestDocument | null>();
  for (const element of json) {
    if (isRecord(element) && element.found !== undefined) {
      const document = readDocument(element.found);
      answers.set(relativeName(document.name, target), document);
    } else if (isRecord(element) && typeof element.missing === "string") {
      answers.set(relativeName(element.missing, target), null);
    } else {
      throw malformed("a document read");
    }
  }
  return answers;
}

function documentShape(json: unknown, target: FirestoreTarget): ShapedResult {
  const answers = [...readBatchGet(json, target)];
  if (answers.length !== 1) throw malformed("a document read");
  const [[path, document]] = answers;
  if (document !== null) return documentRows([document], undefined, target);
  return {
    rows: [],
    fields: ["__name__"],
    columnTypes: { __name__: "string" },
    warnings: [RESULT_SENTENCES.missingDocument(path)],
  };
}

function getAllShape(json: unknown, order: readonly string[], target: FirestoreTarget): ShapedResult {
  const answers = readBatchGet(json, target);
  const found: RestDocument[] = [];
  const missing: string[] = [];
  for (const path of order) {
    const document = answers.get(path);
    if (document !== undefined && document !== null) found.push(document);
    else if (!missing.includes(path)) missing.push(path);
  }
  const shaped = documentRows(found, undefined, target);
  return missing.length === 0
    ? shaped
    : { ...shaped, warnings: [...shaped.warnings, RESULT_SENTENCES.missingDocuments(missing)] };
}

function explainShape(json: unknown): ShapedResult {
  const stream = readQueryStream(json);
  if (!isRecord(stream.explainMetrics)) throw new QueryError(RESULT_SENTENCES.noPlan, FIRESTORE_TYPE);
  const { planSummary, executionStats } = stream.explainMetrics;
  const indexesUsed = isRecord(planSummary) && Array.isArray(planSummary.indexesUsed) ? planSummary.indexesUsed : [];
  return {
    rows: [{ indexesUsed, executionStats: executionStats ?? null }],
    fields: ["indexesUsed", "executionStats"],
    warnings: [RESULT_SENTENCES.explainReturned(stream.documents.length + stream.aggregates.length)],
  };
}

/** One answer as grid rows, in the shape its statement compiled to. */
export function shapeResult(json: unknown, shape: ResultShape, target: FirestoreTarget): ShapedResult {
  switch (shape.kind) {
    case "documents":
      return documentRows(readQueryStream(json).documents, shape.select, target);
    case "aggregation":
      return aggregationRows(json, shape.keys, target);
    case "collectionIds":
      return collectionIdRows(json, shape.parent);
    case "documentNames":
      return documentNameRows(json, target);
    case "document":
      return documentShape(json, target);
    case "getAll":
      return getAllShape(json, shape.order, target);
    case "explain":
      return explainShape(json);
  }
}
