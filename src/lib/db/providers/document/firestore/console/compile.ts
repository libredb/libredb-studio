/**
 * A typed console statement into one request of the closed table (spec 5.4 compile rules, S1). Pure and
 * browser-safe. It raises, with the statement's line and column, every refusal the Admin SDK raises before a
 * request, and leaves everything else for Firestore to validate.
 */
import { QueryError } from "@/lib/db/errors";
import { LIMITS } from "../constants";
import { type FieldPathSegments, isDocumentId, wireFieldPath } from "../field-path";
import { type FirestoreTarget, fullDocumentName, idRefusal, isDocumentPath, verbParentHasColon } from "../names";
import type { FirestoreRequest } from "../requests";
import { encodeLiteral, type Literal, type RestValue } from "../values";
import { firestoreQueryError } from "./lexer";
import {
  type AggregationSpec,
  type CursorBound,
  type FilterNode,
  type NearestSpec,
  type Operator,
  type QueryOps,
  type QuerySource,
  type Statement,
  splitText,
} from "./parser";

/** What a compile step needs besides the node: the text refusals quote, the database, the queried source. */
export interface CompileScope {
  readonly text: string;
  readonly target: FirestoreTarget;
  readonly source: QuerySource;
}

export const COMPILE_SENTENCES = {
  nullOrNaN: (value: "null" | "NaN"): string => `A comparison with ${value} takes only == or !=`,
  arrayOperand: (op: string): string => `The operator ${op} takes an array of values`,
  idArrayOperator: "FieldPath.documentId() cannot be compared with array-contains or array-contains-any",
  idValue: 'A value compared with FieldPath.documentId() is a document id string or db.doc("path")',
  idSlash: "A document id compared with FieldPath.documentId() on a collection is a plain id, without /",
  idChild: (collection: string): string =>
    `db.doc() compared with FieldPath.documentId() must name a document directly in ${collection}`,
  groupIdPath:
    "A value compared with FieldPath.documentId() on a collection group is a document path, with an even number of segments",
  cursorArity: (values: number, orders: number): string =>
    `This cursor holds ${values} values but the query has ${orders} orderBy() fields; give at most one value per orderBy() field`,
  queryLimit: "A query's limit is an integer from 0 to 1,000",
  aggregationLimit: "An aggregation's limit is an integer from 0 to 2,147,483,647",
  offsetRange: "offset() takes an integer from 0 to 1,000",
  colonQuery: (document: string, collection: string): string =>
    `Studio cannot query a subcollection of a document whose id contains a colon (${JSON.stringify(document)}); query it through its collection group instead, starting with db.collectionGroup(${JSON.stringify(collection)})`,
  aggregations: "A statement takes 1 to 5 aggregations",
  nearestLimit: "findNearest() takes a limit from 1 to 1,000",
  nearestVector: "queryVector holds 1 to 2,048 numbers",
  colonList: (document: string): string =>
    `Studio cannot list the subcollections of a document whose id contains a colon (${JSON.stringify(document)})`,
  explainKind: (noun: string): string =>
    `The Explain button plans a query, a vector query or an aggregation; ${noun} has no plan`,
  explainOwn: "This statement calls explain() itself; run it with Run, or remove explain() to use the Explain button",
} as const;

const OP_NAMES: Readonly<Record<Operator, string>> = {
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  "==": "EQUAL",
  "!=": "NOT_EQUAL",
  ">=": "GREATER_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  "array-contains": "ARRAY_CONTAINS",
  in: "IN",
  "not-in": "NOT_IN",
  "array-contains-any": "ARRAY_CONTAINS_ANY",
};
const ARRAY_OPERATORS: ReadonlySet<Operator> = new Set<Operator>(["in", "not-in", "array-contains-any"]);

const fail = (scope: CompileScope, at: number, sentence: string): QueryError =>
  firestoreQueryError(scope.text, at, sentence);
const isDirectChild = (segments: readonly string[], parent: readonly string[]): boolean =>
  segments.length === parent.length + 1 && parent.every((segment, index) => segments[index] === segment);

/** encodeLiteral, its position-free refusal re-raised at the literal's offset, so every refusal names a position (S11). */
function encodeAt(literal: Literal, scope: CompileScope, at: number): RestValue {
  try {
    return encodeLiteral(literal, scope.target);
  } catch (error) {
    throw error instanceof QueryError ? fail(scope, at, error.message) : error;
  }
}

/**
 * A value compared with the document id, as the full reference name Firestore requires: a plain id under the
 * queried collection, an even-segment path on a collection group, or a db.doc() reference that lies where the
 * query can find it.
 */
function documentIdValue(literal: Literal, scope: CompileScope, at: number): RestValue {
  const { source } = scope;
  let segments: readonly string[];
  if (literal.kind === "string" && source.kind === "collection") {
    if (literal.value.includes("/")) throw fail(scope, at, COMPILE_SENTENCES.idSlash);
    const refusal = idRefusal(literal.value, "document");
    if (refusal !== null) throw fail(scope, at, refusal);
    segments = [...source.path, literal.value];
  } else if (literal.kind === "string") {
    segments = splitText(literal.value, at, scope.text);
    if (!isDocumentPath(segments)) throw fail(scope, at, COMPILE_SENTENCES.groupIdPath);
  } else if (literal.kind === "reference") {
    if (source.kind === "collection" && !isDirectChild(literal.segments, source.path)) {
      throw fail(scope, at, COMPILE_SENTENCES.idChild(source.path.join("/")));
    }
    segments = literal.segments;
  } else {
    throw fail(scope, at, COMPILE_SENTENCES.idValue);
  }
  return encodeAt({ kind: "reference", segments }, scope, at);
}

/** One filter node as a REST `Filter`. */
export function compileFilter(node: FilterNode, scope: CompileScope): Record<string, unknown> {
  if (node.kind !== "compare") {
    if (node.filters.length === 1) return compileFilter(node.filters[0], scope);
    const filters = node.filters.map((filter) => compileFilter(filter, scope));
    return { compositeFilter: { op: node.kind === "and" ? "AND" : "OR", filters } };
  }
  const field = { fieldPath: wireFieldPath(node.field.path) };
  const op = OP_NAMES[node.op];
  if (isDocumentId(node.field.path)) {
    if (node.op === "array-contains" || node.op === "array-contains-any")
      throw fail(scope, node.at, COMPILE_SENTENCES.idArrayOperator);
    if (node.op !== "in" && node.op !== "not-in")
      return { fieldFilter: { field, op, value: documentIdValue(node.value, scope, node.at) } };
    if (node.value.kind !== "array") throw fail(scope, node.at, COMPILE_SENTENCES.arrayOperand(node.op));
    const values = node.value.items.map((item) => documentIdValue(item, scope, node.at));
    return { fieldFilter: { field, op, value: { arrayValue: { values } } } };
  }
  const unary =
    node.value.kind === "null"
      ? "null"
      : node.value.kind === "double" && node.value.value === "NaN"
        ? "NaN"
        : undefined;
  if (unary !== undefined && (node.op === "==" || node.op === "!=")) {
    const name = unary === "null" ? "NULL" : "NAN";
    return { unaryFilter: { op: node.op === "==" ? `IS_${name}` : `IS_NOT_${name}`, field } };
  }
  if (unary !== undefined) throw fail(scope, node.at, COMPILE_SENTENCES.nullOrNaN(unary));
  if (ARRAY_OPERATORS.has(node.op) && node.value.kind !== "array")
    throw fail(scope, node.at, COMPILE_SENTENCES.arrayOperand(node.op));
  return { fieldFilter: { field, op, value: encodeAt(node.value, scope, node.at) } };
}

export const COMPILE_WARNINGS = {
  defaultLimit:
    "Studio added .limit(100); add your own .limit(n) up to 1,000, or page with .startAfter(<last __name__>)",
  offsetBilling: "Firestore bills every document an offset skips; page with startAfter() to read fewer documents",
  aggregationCost:
    "Firestore bills an aggregation one document read for each batch of up to 1,000 index entries it scans",
} as const;

/** Which request the query feeds: runQuery, runQuery with findNearest, or runAggregationQuery. */
export type QueryMode = "query" | "vector" | "aggregate";

const inRange = (value: number, low: number, high: number): boolean =>
  Number.isInteger(value) && value >= low && value <= high;

/** One cursor: at most one value per explicit orderBy, a position ordered by __name__ as a reference. */
function compileCursor(
  bound: CursorBound,
  ops: QueryOps,
  scope: CompileScope,
): { values: RestValue[]; before: boolean } {
  if (bound.values.length > ops.orderBy.length) {
    throw fail(scope, bound.at, COMPILE_SENTENCES.cursorArity(bound.values.length, ops.orderBy.length));
  }
  const values = bound.values.map((value, index) =>
    isDocumentId(ops.orderBy[index].field.path)
      ? documentIdValue(value, scope, bound.at)
      : encodeAt(value, scope, bound.at),
  );
  return { values, before: bound.before };
}

/**
 * The REST `StructuredQuery` of a chain. Only a plain runQuery gets the default limit, with its warning; an
 * aggregation keeps the limit exactly as written, and a vector query's bound is findNearest's own limit.
 */
export function buildStructuredQuery(
  ops: QueryOps,
  mode: QueryMode,
  scope: CompileScope,
  warnings: string[],
): Record<string, unknown> {
  const { source } = scope;
  const from =
    source.kind === "collection"
      ? { collectionId: source.path[source.path.length - 1] }
      : { collectionId: source.collectionId, allDescendants: true };
  const query: Record<string, unknown> = { from: [from] };
  if (ops.select !== undefined) {
    const fields =
      ops.select.length === 0
        ? [{ fieldPath: "__name__" }]
        : ops.select.map((field) => ({ fieldPath: wireFieldPath(field.path) }));
    query.select = { fields };
  }
  if (ops.where.length === 1) query.where = compileFilter(ops.where[0], scope);
  if (ops.where.length > 1)
    query.where = { compositeFilter: { op: "AND", filters: ops.where.map((node) => compileFilter(node, scope)) } };
  if (ops.orderBy.length > 0) {
    query.orderBy = ops.orderBy.map((order) => ({
      field: { fieldPath: wireFieldPath(order.field.path) },
      direction: order.direction,
    }));
  }
  if (ops.start !== undefined) query.startAt = compileCursor(ops.start, ops, scope);
  if (ops.end !== undefined) query.endAt = compileCursor(ops.end, ops, scope);
  if (ops.offset !== undefined) {
    if (!inRange(ops.offset.value, 0, LIMITS.maxOffset))
      throw fail(scope, ops.offset.at, COMPILE_SENTENCES.offsetRange);
    query.offset = ops.offset.value;
    if (ops.offset.value > 0) warnings.push(COMPILE_WARNINGS.offsetBilling);
  }
  const aggregate = mode === "aggregate";
  if (ops.limit !== undefined) {
    if (!inRange(ops.limit.value, 0, aggregate ? LIMITS.maxAggregationInnerLimit : LIMITS.maxQueryLimit)) {
      throw fail(scope, ops.limit.at, aggregate ? COMPILE_SENTENCES.aggregationLimit : COMPILE_SENTENCES.queryLimit);
    }
    query.limit = ops.limit.value;
  } else if (mode === "query") {
    query.limit = LIMITS.defaultQueryLimit;
    warnings.push(COMPILE_WARNINGS.defaultLimit);
  }
  return query;
}

/** The document the query's verb is sent under: the collection's parent, or the root for a group. */
export function queryParent(scope: CompileScope): readonly string[] {
  const { source } = scope;
  if (source.kind === "collectionGroup") return [];
  const parent = source.path.slice(0, -1);
  if (verbParentHasColon(parent)) {
    throw fail(
      scope,
      source.at,
      COMPILE_SENTENCES.colonQuery(parent[parent.length - 1], source.path[source.path.length - 1]),
    );
  }
  return parent;
}

export type ResultShape =
  | { readonly kind: "documents"; readonly select?: readonly FieldPathSegments[] }
  | { readonly kind: "aggregation"; readonly keys: readonly { wire: string; user: string }[] }
  | { readonly kind: "collectionIds"; readonly parent: readonly string[] }
  | { readonly kind: "documentNames" }
  | { readonly kind: "document" }
  | { readonly kind: "getAll"; readonly order: readonly string[] }
  | { readonly kind: "explain"; readonly analyze: boolean };
export interface CompiledStatement {
  readonly request: FirestoreRequest;
  readonly shape: ResultShape;
  readonly warnings: readonly string[];
}
/** `explainButton`: the Explain button's marker was present, so the statement is planned, never run. */
export interface CompileOptions {
  readonly target: FirestoreTarget;
  readonly explainButton: boolean;
}

type Unexplainable = "getDocument" | "listCollections" | "listDocuments" | "getAll";
const NO_PLAN: Readonly<Record<Unexplainable, string>> = {
  getDocument: "a document read",
  listCollections: "a collection listing",
  listDocuments: "a document listing",
  getAll: "getAll()",
};
type QueryStatement = Extract<Statement, { kind: QueryMode }>;

function compileNearest(nearest: NearestSpec, scope: CompileScope): Record<string, unknown> {
  if (!inRange(nearest.limit, LIMITS.minNearestLimit, LIMITS.maxNearestLimit))
    throw fail(scope, nearest.at, COMPILE_SENTENCES.nearestLimit);
  if (nearest.queryVector.length === 0 || nearest.queryVector.length > LIMITS.maxVectorDimensions) {
    throw fail(scope, nearest.at, COMPILE_SENTENCES.nearestVector);
  }
  return {
    vectorField: { fieldPath: wireFieldPath(nearest.field.path) },
    queryVector: encodeAt({ kind: "vector", values: nearest.queryVector }, scope, nearest.at),
    distanceMeasure: nearest.distanceMeasure,
    limit: nearest.limit,
    ...(nearest.distanceResultField === undefined
      ? {}
      : { distanceResultField: wireFieldPath(nearest.distanceResultField.path) }),
    ...(nearest.distanceThreshold === undefined ? {} : { distanceThreshold: nearest.distanceThreshold }),
  };
}

function compileAggregations(aggregations: readonly AggregationSpec[], scope: CompileScope): Record<string, unknown>[] {
  if (aggregations.length < LIMITS.minAggregations || aggregations.length > LIMITS.maxAggregations) {
    throw fail(scope, aggregations[LIMITS.maxAggregations]?.at ?? scope.source.at, COMPILE_SENTENCES.aggregations);
  }
  return aggregations.map((aggregation, index) => {
    const alias = `aggregate_${index}`;
    if (aggregation.field === undefined) return { alias, count: {} };
    return { alias, [aggregation.op]: { field: { fieldPath: wireFieldPath(aggregation.field.path) } } };
  });
}

function compileQuery(statement: QueryStatement, text: string, options: CompileOptions): CompiledStatement {
  const scope: CompileScope = { text, target: options.target, source: statement.source };
  const warnings: string[] = [];
  const structuredQuery = buildStructuredQuery(statement.ops, statement.kind, scope, warnings);
  if (statement.kind === "vector") structuredQuery.findNearest = compileNearest(statement.nearest, scope);
  const parent = queryParent(scope);
  const analyze = options.explainButton ? false : statement.explain?.analyze;
  const explain = analyze === undefined ? {} : { explainOptions: { analyze } };
  if (statement.kind === "aggregate") {
    const aggregations = compileAggregations(statement.aggregations, scope);
    warnings.push(COMPILE_WARNINGS.aggregationCost);
    const keys = statement.aggregations.map((aggregation, index) => ({
      wire: `aggregate_${index}`,
      user: aggregation.key,
    }));
    return {
      request: {
        kind: "runAggregationQuery",
        parent,
        body: { structuredAggregationQuery: { structuredQuery, aggregations }, ...explain },
      },
      shape: analyze === undefined ? { kind: "aggregation", keys } : { kind: "explain", analyze },
      warnings,
    };
  }
  const select = statement.ops.select?.map((field) => field.path);
  const shape: ResultShape =
    analyze !== undefined
      ? { kind: "explain", analyze }
      : select === undefined
        ? { kind: "documents" }
        : { kind: "documents", select };
  return { request: { kind: "runQuery", parent, body: { structuredQuery, ...explain } }, shape, warnings };
}

function refuseForExplainButton(statement: Statement, text: string): void {
  switch (statement.kind) {
    case "getDocument":
    case "listCollections":
    case "listDocuments":
    case "getAll":
      throw firestoreQueryError(text, 0, COMPILE_SENTENCES.explainKind(NO_PLAN[statement.kind]));
    default:
      if (statement.explain !== undefined)
        throw firestoreQueryError(text, statement.explain.at, COMPILE_SENTENCES.explainOwn);
  }
}

/** One statement as one closed-table request, the shape its answer is read in, and its warnings. */
export function compileStatement(statement: Statement, text: string, options: CompileOptions): CompiledStatement {
  if (options.explainButton) refuseForExplainButton(statement, text);
  switch (statement.kind) {
    case "query":
    case "vector":
    case "aggregate":
      return compileQuery(statement, text, options);
    case "getDocument":
      return {
        request: { kind: "batchGet", body: { documents: [fullDocumentName(options.target, statement.path)] } },
        shape: { kind: "document" },
        warnings: [],
      };
    case "listCollections": {
      const { parent } = statement;
      if (verbParentHasColon(parent))
        throw firestoreQueryError(text, statement.at, COMPILE_SENTENCES.colonList(parent[parent.length - 1]));
      return {
        request: { kind: "listCollectionIds", parent, pageSize: LIMITS.idListingPageSize },
        shape: { kind: "collectionIds", parent },
        warnings: [],
      };
    }
    case "listDocuments": {
      const { collection } = statement;
      return {
        request: {
          kind: "listDocuments",
          parent: collection.slice(0, -1),
          collectionId: collection[collection.length - 1],
          pageSize: LIMITS.collectionPageSizeUnmasked,
          showMissing: true,
        },
        shape: { kind: "documentNames" },
        warnings: [],
      };
    }
    case "getAll": {
      const names = statement.refs.map((ref) => fullDocumentName(options.target, ref));
      return {
        request: { kind: "batchGet", body: { documents: [...new Set(names)] } },
        shape: { kind: "getAll", order: statement.refs.map((ref) => ref.join("/")) },
        warnings: [],
      };
    }
  }
}
