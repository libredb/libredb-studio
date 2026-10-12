/**
 * The closed request table (spec S1): the only seven requests Studio sends Firestore, each with its method, path
 * shape, query parameter names and top-level body keys. `buildRequest` refuses anything else with a QueryError
 * before it returns, and the transport sends nothing it did not build, so no write, transaction or read-time field
 * can leave Studio. Paths are built from validated segments, each percent-encoded on its own; query pairs are raw
 * and the transport encodes them. Browser-safe.
 */
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, LIMITS, SENTENCES } from "./constants";
import {
  databaseIdRefusal,
  encodeSegment,
  encodeSegments,
  type FirestoreTarget,
  idRefusal,
  isDocumentPath,
  projectIdRefusal,
  relativeSegments,
  segmentsRefusal,
  verbParentHasColon,
} from "./names";

export type FirestoreRequest =
  | { kind: "database" }
  | { kind: "get"; path: readonly string[]; maskFieldPaths?: readonly string[] }
  | {
      kind: "listDocuments";
      parent: readonly string[];
      collectionId: string;
      pageSize?: number;
      pageToken?: string;
      showMissing?: boolean;
      maskFieldPaths?: readonly string[];
    }
  | { kind: "listCollectionIds"; parent: readonly string[]; pageSize?: number; pageToken?: string }
  | {
      kind: "runQuery";
      parent: readonly string[];
      body: Readonly<{ structuredQuery: unknown; explainOptions?: { analyze: boolean } }>;
    }
  | {
      kind: "runAggregationQuery";
      parent: readonly string[];
      body: Readonly<{ structuredAggregationQuery: unknown; explainOptions?: { analyze: boolean } }>;
    }
  | { kind: "batchGet"; body: Readonly<{ documents: readonly string[]; mask?: { fieldPaths: readonly string[] } }> };

export type ResponseCapKind = "large" | "small";

export interface BuiltRequest {
  readonly method: "GET" | "POST";
  /** Already percent-encoded, segment by segment. */
  readonly path: string;
  /** Raw name and value pairs, in order; the transport encodes them. */
  readonly query: readonly (readonly [string, string])[];
  readonly body?: string;
  readonly cap: ResponseCapKind;
}

export const REQUEST_SENTENCES = Object.freeze({
  notInTable:
    "Studio sends Firestore only the seven read requests of its closed table, and this is not one of them, so nothing was sent",
  extraKey: (kind: string, key: string): string =>
    `A Firestore ${kind} request cannot carry "${key}"; Studio sends only the fields its closed table names for it, so nothing was sent`,
  target: "The connection's Project ID or Database ID is not valid, so nothing was sent",
  documentPath: "A document read needs a document path: an even number of segments, such as users/alice",
  parentPath: "A Firestore request's parent must be the database root or a document path, an even number of segments",
  pageSize: (max: number): string => `A page size must be an integer from 1 to ${max}`,
  pageToken: "A page token must be a non-empty string",
  showMissing: "showMissing must be true or false",
  maskFieldPaths: "A field mask names one or more non-empty field paths",
  bodyObject: (key: string): string => `The ${key} of a Firestore request must be an object`,
  explainOptions: "explainOptions must be exactly { analyze: true } or { analyze: false }",
  batchGetDocuments: "batchGet names 1 to 1,000 documents, each a full document name in this connection's database",
});

/** The keys each request may carry, by kind; a Map so an inherited name such as "constructor" is no kind. */
const REQUEST_KEYS = new Map<string, readonly string[]>([
  ["database", ["kind"]],
  ["get", ["kind", "path", "maskFieldPaths"]],
  ["listDocuments", ["kind", "parent", "collectionId", "pageSize", "pageToken", "showMissing", "maskFieldPaths"]],
  ["listCollectionIds", ["kind", "parent", "pageSize", "pageToken"]],
  ["runQuery", ["kind", "parent", "body"]],
  ["runAggregationQuery", ["kind", "parent", "body"]],
  ["batchGet", ["kind", "body"]],
]);

export function buildRequest(target: FirestoreTarget, request: FirestoreRequest): BuiltRequest {
  const shape: unknown = request;
  const allowed = isRecord(shape) && typeof shape.kind === "string" ? REQUEST_KEYS.get(shape.kind) : undefined;
  if (!isRecord(shape) || allowed === undefined) throw refuse(REQUEST_SENTENCES.notInTable);
  for (const key of Object.keys(shape))
    if (!allowed.includes(key)) throw refuse(REQUEST_SENTENCES.extraKey(request.kind, key));
  if (projectIdRefusal(target.projectId) !== null || databaseIdRefusal(target.databaseId) !== null)
    throw refuse(REQUEST_SENTENCES.target);
  const base = `/v1/projects/${encodeSegment(target.projectId)}/databases/${encodeSegment(target.databaseId)}`;
  const documents = `${base}/documents`;
  switch (request.kind) {
    case "get":
      return {
        method: "GET",
        path: `${documents}/${encodeSegments(documentPath(request.path))}`,
        query: maskPairs(request.maskFieldPaths),
        cap: "small",
      };
    case "listDocuments": {
      const parent = parentPath(request.parent);
      const collection = idRefusal(request.collectionId, "collection");
      if (collection !== null) throw refuse(collection);
      const query: [string, string][] = [];
      const max =
        request.maskFieldPaths === undefined ? LIMITS.collectionPageSizeUnmasked : LIMITS.collectionPageSizeMax;
      // Always sent: left out, Firestore would choose the page size, and the spec 8.2 bound would not hold.
      query.push(["pageSize", String(pageSize(request.pageSize, max))]);
      if (request.pageToken !== undefined) query.push(["pageToken", pageToken(request.pageToken)]);
      if (showMissing(request.showMissing)) query.push(["showMissing", "true"]);
      query.push(...maskPairs(request.maskFieldPaths));
      return {
        method: "GET",
        path: `${documents}${parent}/${encodeSegment(request.collectionId)}`,
        query,
        cap: "large",
      };
    }
    case "listCollectionIds": {
      const parent = verbParent(request.parent, "list");
      const body = {
        ...(request.pageSize === undefined ? {} : { pageSize: pageSize(request.pageSize, LIMITS.idListingPageSize) }),
        ...(request.pageToken === undefined ? {} : { pageToken: pageToken(request.pageToken) }),
      };
      return {
        method: "POST",
        path: `${documents}${parent}:listCollectionIds`,
        query: [],
        body: JSON.stringify(body),
        cap: "small",
      };
    }
    case "runQuery":
    case "runAggregationQuery": {
      const parent = verbParent(request.parent, "query");
      const queryKey = request.kind === "runQuery" ? "structuredQuery" : "structuredAggregationQuery";
      const body = checkedBody(request.kind, request.body, [queryKey, "explainOptions"]);
      if (!isRecord(body[queryKey])) throw refuse(REQUEST_SENTENCES.bodyObject(queryKey));
      if (body.explainOptions !== undefined) explainOptions(body.explainOptions);
      return {
        method: "POST",
        path: `${documents}${parent}:${request.kind}`,
        query: [],
        body: JSON.stringify(body),
        cap: request.kind === "runQuery" ? "large" : "small",
      };
    }
    case "batchGet": {
      const body = checkedBody(request.kind, request.body, ["documents", "mask"]);
      batchGetDocuments(target, body.documents);
      if (body.mask !== undefined) batchGetMask(body.mask);
      return { method: "POST", path: `${documents}:batchGet`, query: [], body: JSON.stringify(body), cap: "large" };
    }
    case "database":
      return { method: "GET", path: base, query: [], cap: "small" };
  }
}

function documentPath(path: readonly string[]): readonly string[] {
  if (!isDocumentPath(path)) throw refuse(REQUEST_SENTENCES.documentPath);
  const refusal = segmentsRefusal(path);
  if (refusal !== null) throw refuse(refusal);
  return path;
}

/** "" for the database root, else "/" and the encoded document path. */
function parentPath(parent: readonly string[]): string {
  if (parent.length === 0) return "";
  if (!isDocumentPath(parent)) throw refuse(REQUEST_SENTENCES.parentPath);
  const refusal = segmentsRefusal(parent);
  if (refusal !== null) throw refuse(refusal);
  return `/${encodeSegments(parent)}`;
}

/** A verb request's parent; one whose last segment holds ":" is refused, because Firestore reads it as the verb. */
function verbParent(parent: readonly string[], use: "list" | "query"): string {
  const path = parentPath(parent);
  if (verbParentHasColon(parent))
    throw refuse(
      use === "list" ? SENTENCES.colonSubcollections(parent.join("/")) : SENTENCES.colonVerbParent(parent.join("/")),
    );
  return path;
}

function pageSize(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max)
    throw refuse(REQUEST_SENTENCES.pageSize(max));
  return value;
}

function pageToken(value: unknown): string {
  if (typeof value !== "string" || value === "") throw refuse(REQUEST_SENTENCES.pageToken);
  return value;
}

function showMissing(value: unknown): boolean {
  if (value !== undefined && typeof value !== "boolean") throw refuse(REQUEST_SENTENCES.showMissing);
  return value === true;
}

function fieldPaths(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((path) => typeof path === "string" && path !== ""))
    throw refuse(REQUEST_SENTENCES.maskFieldPaths);
  return value as readonly string[];
}

function maskPairs(paths: readonly string[] | undefined): [string, string][] {
  if (paths === undefined) return [];
  return fieldPaths(paths).map((path): [string, string] => ["mask.fieldPaths", path]);
}

function checkedBody(kind: string, body: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(body)) throw refuse(REQUEST_SENTENCES.bodyObject("body"));
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw refuse(REQUEST_SENTENCES.extraKey(kind, key));
  return body;
}

function explainOptions(value: unknown): void {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value.analyze !== "boolean")
    throw refuse(REQUEST_SENTENCES.explainOptions);
}

function batchGetDocuments(target: FirestoreTarget, documents: unknown): void {
  const valid =
    Array.isArray(documents) &&
    documents.length >= 1 &&
    documents.length <= LIMITS.maxGetAllRefs &&
    documents.every((name) => {
      const segments = typeof name === "string" ? relativeSegments(target, name) : null;
      return segments !== null && isDocumentPath(segments);
    });
  if (!valid) throw refuse(REQUEST_SENTENCES.batchGetDocuments);
}

function batchGetMask(mask: unknown): void {
  if (!isRecord(mask) || Object.keys(mask).length !== 1) throw refuse(REQUEST_SENTENCES.maskFieldPaths);
  fieldPaths(mask.fieldPaths);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refuse(message: string): QueryError {
  return new QueryError(message, FIRESTORE_TYPE);
}
