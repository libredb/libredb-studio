/**
 * The Firestore object surface (spec 5.1, 5.2, 5.5): the `collection` kind the tree lists (a relation with columns,
 * whose rows Browse Keys opens by their bare id) and the `document` kind the Keys panel enumerates, with a Source
 * tab. No container level.
 *
 * Collections are listed and counted from the collection id listing, every page of `listCollectionIds` up to the
 * id-listing cap, each id held to the id rules and sorted by UTF-8 bytes because Firestore promises no order. A field
 * expand samples 20 documents (20 billed reads, on the user's expand); the bulk describe reads no document and
 * answers `__name__` alone, because it runs on every inventory and plan-mode walk. A document's Source tab is one
 * `get` and one subcollection listing.
 *
 * Every request carries the context its failure is mapped under: the session's credential kind and the credential's
 * secret forms (`CallBase`, built once per session by the provider, so a Google message quoting the credential is
 * withheld), the connection's target, and the surface that asked, so an answer past its cap is worded for it.
 */
import { QueryError } from "@/lib/db/errors";
import { applySourceBound, callerBoundTruncationReason } from "@/lib/db/object-kinds";
import type {
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
  ObjectKindSpec,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import { FIRESTORE_TYPE, LIMITS, SENTENCES } from "./constants";
import { type CallPhase, type ErrorContext, googleErrorOf } from "./errors";
import { compareUtf8, fullDocumentName, idRefusal, isDocumentPath, splitPath, verbParentHasColon } from "./names";
import { readQueryStream } from "./results";
import { collectionChildId, documentSegments, foreignDocumentSentence, inferColumns, nameColumn } from "./sampling";
import type { FirestoreClient } from "./transport";
import { decodeFields, type RestDocument } from "./values";

/** What every request of one session carries besides the target: the credential kind and its secret forms. */
export interface CallBase {
  readonly credential: ErrorContext["credential"];
  readonly secretForms: readonly string[];
}

/** The surface that asked; the console's `listCollections()` reads through the same listing (spec 5.6). */
export type CallSurface = "keys" | "tree" | "source" | "console";

export const FIRESTORE_LISTING_SENTENCES = Object.freeze({
  idCap: `Studio stops after ${LIMITS.idListingRequests} id listing requests at one level, so ids past the ones those requests returned are not listed.`,
  malformed: "Firestore answered a listing Studio cannot read.",
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The context every request of a surface read carries. */
export function callContext(
  client: FirestoreClient,
  base: CallBase,
  phase: CallPhase,
  surface?: ErrorContext["surface"],
): ErrorContext {
  return {
    phase,
    credential: base.credential,
    secretForms: base.secretForms,
    target: client.target,
    ...(surface === undefined ? {} : { surface }),
  };
}

function malformedListing(): QueryError {
  return new QueryError(FIRESTORE_LISTING_SENTENCES.malformed, FIRESTORE_TYPE);
}

function readIdPage(answer: unknown): { readonly ids: readonly string[]; readonly next: string | undefined } {
  if (!isRecord(answer)) throw malformedListing();
  const { collectionIds, nextPageToken } = answer;
  if (
    collectionIds !== undefined &&
    !(Array.isArray(collectionIds) && collectionIds.every((id) => typeof id === "string"))
  )
    throw malformedListing();
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") throw malformedListing();
  return {
    ids: (collectionIds ?? []) as string[],
    next: nextPageToken === undefined || nextPageToken === "" ? undefined : nextPageToken,
  };
}

/**
 * Every collection id directly under `parent` (the database root for `[]`), up to `LIMITS.idListingRequests`
 * requests of `LIMITS.idListingPageSize` ids; `complete` is false when the cap stopped the read, and `skipped` counts
 * the distinct ids the id rules refused.
 */
export async function listCollectionIdsSorted(
  client: FirestoreClient,
  parent: readonly string[],
  signal: AbortSignal,
  base: CallBase,
  surface: CallSurface,
): Promise<{ ids: string[]; complete: boolean; skipped: number }> {
  const listed = new Set<string>();
  const context = callContext(client, base, "listing", surface);
  let token: string | undefined;
  let complete = false;
  for (let request = 0; request < LIMITS.idListingRequests && !complete; request += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each page's request carries the token the one before it returned.
    const answer = await client.send(
      {
        kind: "listCollectionIds",
        parent,
        pageSize: LIMITS.idListingPageSize,
        ...(token === undefined ? {} : { pageToken: token }),
      },
      { signal, context },
    );
    const page = readIdPage(answer);
    for (const id of page.ids) listed.add(id);
    token = page.next;
    complete = token === undefined;
  }
  const ids = [...listed].filter((id) => idRefusal(id, "collection") === null).sort(compareUtf8);
  return { ids, complete, skipped: listed.size - ids.length };
}

export const FIRESTORE_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  {
    id: "collection",
    role: "relation",
    label: "Collection",
    labelPlural: "Collections",
    hasColumns: true,
    countIsListing: true,
  },
  {
    id: "document",
    role: "config",
    label: "Document",
    labelPlural: "Documents",
    enumeratedBy: "key-browser",
    hasSource: true,
    sourceLanguage: "json",
  },
] as const);

export const FIRESTORE_OBJECT_SENTENCES = Object.freeze({
  container: (container: readonly string[]): string =>
    `A Firestore connection has no container level; received ${JSON.stringify(container)}`,
  kind: (kind: string): string => `Firestore declares no object kind "${kind}"`,
  documentsElsewhere:
    'Documents are listed in the Keys panel and with db.collection("<collection>").listDocuments() in the console.',
  collectionPath: (path: readonly string[]): string =>
    `A Firestore collection in the tree is addressed by its id alone; received ${JSON.stringify(path)}`,
  documentPath: (path: readonly string[]): string =>
    `A Firestore document is addressed by one segment holding its full path, such as "users/alice"; received ${JSON.stringify(path)}`,
  noSource: "A collection has no Source tab: open one of its documents from the Keys panel.",
  missing: (path: string): string => `No document exists at ${path}.`,
  malformedDocument: "Firestore answered a document Studio cannot read.",
  idCapReason: `Studio stopped listing collection ids after ${LIMITS.idListingRequests} requests`,
  sampledFrom: `the first ${LIMITS.idListingRequests} pages of collection ids Firestore listed`,
});

const O = FIRESTORE_OBJECT_SENTENCES;

function refuse(message: string): QueryError {
  return new QueryError(message, FIRESTORE_TYPE);
}

function requireRoot(container: readonly string[]): void {
  if (container.length !== 0) throw refuse(O.container(container));
}

function requireKind(kind: string): void {
  if (!FIRESTORE_OBJECT_KINDS.some((spec) => spec.id === kind)) throw refuse(O.kind(kind));
}

export async function countFirestoreObjects(
  client: FirestoreClient,
  container: readonly string[],
  signal: AbortSignal,
  base: CallBase,
): Promise<Record<string, KindCount>> {
  requireRoot(container);
  const listing = await listCollectionIdsSorted(client, [], signal, base, "tree");
  const count = listing.ids.length;
  return { collection: listing.complete ? { count } : { count, sampledFrom: O.sampledFrom } };
}

/**
 * The top-level collections; documents are the Keys panel's and are refused by name. A `DatabaseObject[]` cannot say
 * the id cap stopped the read, so the capped list is answered as it stands and `countObjects` reports the cap.
 */
export async function listFirestoreObjects(
  client: FirestoreClient,
  container: readonly string[],
  kind: string,
  signal: AbortSignal,
  base: CallBase,
): Promise<DatabaseObject[]> {
  requireRoot(container);
  if (kind === "document") throw refuse(O.documentsElsewhere);
  requireKind(kind);
  const listing = await listCollectionIdsSorted(client, [], signal, base, "tree");
  return listing.ids.map((id) => ({ path: [id], name: id, kind: "collection" }));
}

/**
 * Whether a document an answer carried directly under `collection` joins the sample: one whose id the id rules
 * refuse is left out, and every other name is `collectionChildId`'s to refuse, which reads a refused id as foreign.
 */
function sampledChild(client: FirestoreClient, collection: readonly string[], name: string): boolean {
  const parentName = `${fullDocumentName(client.target, collection)}/`;
  const raw = name.startsWith(parentName) ? name.slice(parentName.length) : "";
  if (raw !== "" && !raw.includes("/") && idRefusal(raw, "document") !== null) return false;
  collectionChildId(client.target, collection, name);
  return true;
}

/**
 * A collection's columns from `LIMITS.sampleDocuments` documents in `__name__` order. Each sampled document must be a
 * direct child of the collection read (S5), and one whose id breaks the id rules is left out of the sample.
 */
export async function describeFirestoreObject(
  client: FirestoreClient,
  path: readonly string[],
  kind: string,
  signal: AbortSignal,
  base: CallBase,
): Promise<ObjectDetail> {
  requireKind(kind);
  if (kind === "document") throw refuse(O.documentsElsewhere);
  if (path.length !== 1 || idRefusal(path[0], "collection") !== null) throw refuse(O.collectionPath(path));
  const answer = await client.send(
    {
      kind: "runQuery",
      parent: [],
      body: {
        structuredQuery: {
          from: [{ collectionId: path[0] }],
          orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
          limit: LIMITS.sampleDocuments,
        },
      },
    },
    { signal, context: callContext(client, base, "listing", "tree") },
  );
  const sample = readQueryStream(answer).documents.filter((document) => sampledChild(client, path, document.name));
  return {
    path: [path[0]],
    columns: inferColumns(sample, client.target),
    indexes: [],
    foreignKeys: [],
  };
}

/** Every listed collection with `__name__` alone, reading no document; a bound that bites is reported. */
export async function describeFirestoreObjects(
  client: FirestoreClient,
  container: readonly string[],
  kind: string,
  limit: number | undefined,
  signal: AbortSignal,
  base: CallBase,
): Promise<ObjectDetailBatch> {
  requireRoot(container);
  requireKind(kind);
  if (kind === "document") return { details: [] };
  const listing = await listCollectionIdsSorted(client, [], signal, base, "tree");
  const detail = (id: string): ObjectDetail => ({ path: [id], columns: [nameColumn()], indexes: [], foreignKeys: [] });
  if (limit !== undefined && listing.ids.length > limit)
    return {
      details: listing.ids.slice(0, limit).map(detail),
      truncated: { limit, reason: callerBoundTruncationReason(limit) },
    };
  const details = listing.ids.map(detail);
  return listing.complete ? { details } : { details, truncated: { limit: details.length, reason: O.idCapReason } };
}

type TextPart = Extract<ObjectSourcePart, { readonly text: string }>;

function rendered(id: string, label: string, value: unknown, limit: number | undefined): TextPart {
  const bounded = applySourceBound(JSON.stringify(value, null, 2), limit);
  return {
    id,
    label,
    text: bounded.text,
    language: "json",
    form: "complete",
    origin: "rendered",
    ...(bounded.truncated === undefined ? {} : { truncated: bounded.truncated }),
  };
}

function readDocument(answer: unknown): RestDocument {
  if (!isRecord(answer) || typeof answer.name !== "string") throw refuse(O.malformedDocument);
  return answer as unknown as RestDocument;
}

async function subcollectionPart(
  client: FirestoreClient,
  segments: readonly string[],
  limit: number | undefined,
  signal: AbortSignal,
  base: CallBase,
): Promise<ObjectSourcePart> {
  // The document itself read fine: why its subcollections are not listed is a statement about it, not a failure.
  if (verbParentHasColon(segments))
    return {
      id: "subcollections",
      label: "Subcollections",
      unavailable: SENTENCES.colonSubcollections(segments.join("/")),
      statement: true,
    };
  const listing = await listCollectionIdsSorted(client, segments, signal, base, "source");
  const part = rendered("subcollections", "Subcollections", listing.ids, limit);
  if (listing.complete || part.truncated !== undefined) return part;
  return { ...part, truncated: { limit: listing.ids.length, reason: O.idCapReason } };
}

/** A document's three parts: its decoded data, the REST document verbatim, and its subcollection ids. */
export async function readFirestoreSource(
  client: FirestoreClient,
  path: readonly string[],
  kind: string,
  limit: number | undefined,
  signal: AbortSignal,
  base: CallBase,
): Promise<ObjectSourceDocument> {
  requireKind(kind);
  if (kind !== "document") throw refuse(O.noSource);
  if (path.length !== 1) throw refuse(O.documentPath(path));
  const segments = splitPath(path[0]);
  if (!isDocumentPath(segments)) throw refuse(O.documentPath(path));
  let document: RestDocument;
  try {
    document = readDocument(
      await client.send(
        { kind: "get", path: segments },
        { signal, context: callContext(client, base, "listing", "source") },
      ),
    );
  } catch (error) {
    if (googleErrorOf(error)?.httpStatus === 404) throw refuse(O.missing(path[0]));
    throw error;
  }
  if (documentSegments(client.target, document.name).join("/") !== segments.join("/"))
    throw refuse(foreignDocumentSentence(document.name));
  return {
    path: [path[0]],
    kind: "document",
    parts: [
      rendered("data", "Data", decodeFields(document.fields, client.target), limit),
      rendered("document", "Document", document, limit),
      await subcollectionPart(client, segments, limit, signal, base),
    ],
  };
}
