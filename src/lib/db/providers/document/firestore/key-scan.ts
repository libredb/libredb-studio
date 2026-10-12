/**
 * The Keys panel over Firestore (spec 5.3): one level per page. The pattern is a path relative to `documents`; its
 * complete segments name the level and the text after its last "/" is a partial id that filters it.
 *
 * The root and a document level list collection ids: the whole list is read with `listCollectionIdsSorted` on every
 * page, filtered by the partial, its folders sorted by UTF-8 bytes and paged after the cursor's last entry
 * (start-after), so a list that changes between two pages neither skips nor repeats a folder. Every refusal of the
 * options, the pattern and the cursor comes before any request; a document whose id holds ":" cannot be listed,
 * because a verb request under it is refused, and the refusal says how to query its subcollections instead.
 * Every request names the `keys` surface, so an answer past its cap gets the panel's own sentence from errors.ts.
 *
 * A collection level with no partial is one `listDocuments` with `showMissing`, because a parent that exists only
 * through its subcollections is invisible to queries; no mask is sent, because none returns names only while
 * `showMissing` is set (measured on emulator 1.22.0), so `pageSize` is at most 50 and at most half the page's room,
 * which keeps a document's key and folder on one page unless the count is 1. A document is present exactly when it
 * carries `createTime`. A typed id reads stored documents only, with a names-only `runQuery` over the `__name__`
 * range from the id to its successor, and says so in `readOutcome`.
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { FIRESTORE_TYPE, LIMITS, SENTENCES } from "./constants";
import { decodeLevelCursor, encodeLevelCursor, FIRESTORE_CURSOR_SENTENCES, type LevelCursor } from "./cursor";
import { googleErrorOf } from "./errors";
import { compareUtf8, fullDocumentName, idRefusal, verbParentHasColon } from "./names";
import { type CallBase, callContext, FIRESTORE_LISTING_SENTENCES, isRecord, listCollectionIdsSorted } from "./objects";
import { readQueryStream } from "./results";
import { collectionChildId } from "./sampling";
import type { FirestoreClient } from "./transport";
import type { RestDocument } from "./values";

export const FIRESTORE_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  defaultCount: LIMITS.keysPageDefault,
  maxCount: LIMITS.keysPageMax,
  separator: "/",
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "none",
  levels: { rootKind: "collection" },
});

export const FIRESTORE_KEY_SCAN_SENTENCES = Object.freeze({
  count: "A page holds 1 to 1,000 entries.",
  database: "A Firestore connection walks one database, so a page names no database number.",
  levelOnly: "The Keys panel lists Firestore one level at a time.",
  notText: "The prefix holds a character that is not text: type it again.",
  emptySegment: "The prefix holds an empty segment between two slashes: remove the extra slash.",
  partialTooLong: `A typed id holds at most ${LIMITS.maxIdBytes.toLocaleString("en-US")} bytes.`,
  skipped: "Ids that break Firestore's id rules cannot be shown or opened, so they are counted here and not listed.",
  numericPartial:
    "Ids that start with __id are numeric ids from a Datastore import, which Studio cannot search by prefix: list the collection without a typed id.",
  colonSearch:
    "Studio cannot search ids under a document whose id contains a colon: list the collection without a typed id.",
  partialUnknown:
    "A typed id lists stored documents only; parents that exist only through their subcollections appear when the collection is listed without one.",
});

const S = FIRESTORE_KEY_SCAN_SENTENCES;

export interface LevelRequest {
  readonly pattern: string;
  readonly complete: readonly string[];
  readonly partial: string;
  readonly count: number;
  readonly cursor: LevelCursor | null;
}

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, FIRESTORE_TYPE);
}

/** The level a pattern names and the partial id filtering it; a segment the id rules refuse is refused by its sentence. */
export function parseLevelPattern(pattern: string): { complete: string[]; partial: string } {
  if (!pattern.isWellFormed()) throw refuse(S.notText);
  const complete = pattern.split("/");
  const partial = complete.pop() as string;
  complete.forEach((segment, index) => {
    if (segment === "") throw refuse(S.emptySegment);
    const refusal = idRefusal(segment, index % 2 === 0 ? "collection" : "document");
    if (refusal !== null) throw refuse(refusal);
  });
  if (new TextEncoder().encode(partial).length > LIMITS.maxIdBytes) throw refuse(S.partialTooLong);
  return { complete, partial };
}

/** Every refusal a page gives before any request: the options in the order the route reads them, the pattern, the cursor. */
export function readLevelRequest(options: KeyScanOptions): LevelRequest {
  if (!Number.isSafeInteger(options.count) || options.count < 1 || options.count > LIMITS.keysPageMax)
    throw refuse(S.count);
  if (options.database !== undefined) throw refuse(S.database);
  if (options.level !== true) throw refuse(S.levelOnly);
  const pattern = options.pattern ?? "";
  const { complete, partial } = parseLevelPattern(pattern);
  return { pattern, complete, partial, count: options.count, cursor: decodeLevelCursor(options.cursor, pattern) };
}

/** The last entry an id level's cursor names; a cursor of the collection level's shape is refused. */
function afterOf(cursor: LevelCursor): string {
  if (!("a" in cursor)) throw refuse(FIRESTORE_CURSOR_SENTENCES.malformed);
  return cursor.a;
}

/** One page of the root (no complete segment) or of a document level (an even number of them). */
export async function scanIdLevel(
  request: LevelRequest,
  client: FirestoreClient,
  signal: AbortSignal,
  base: CallBase,
): Promise<KeyScanPage> {
  const after = request.cursor === null ? undefined : afterOf(request.cursor);
  const parent = request.complete;
  if (parent.length > 0 && verbParentHasColon(parent)) throw refuse(SENTENCES.colonSubcollections(parent.join("/")));
  const listing = await listCollectionIdsSorted(client, parent, signal, base, "keys");
  const prefix = parent.length === 0 ? "" : `${parent.join("/")}/`;
  const folders = listing.ids
    .filter((id) => id.startsWith(request.partial))
    .map((id) => `${prefix}${id}/`)
    .sort(compareUtf8);
  const remaining = after === undefined ? folders : folders.filter((folder) => compareUtf8(folder, after) > 0);
  const prefixes = remaining.slice(0, request.count);
  const cursor =
    remaining.length > request.count
      ? encodeLevelCursor({ v: 1, p: request.pattern, a: prefixes[prefixes.length - 1] })
      : "0";
  return {
    keys: [],
    prefixes,
    cursor,
    types: {},
    total: 0,
    // The panel adds skipped up across a level's pages, so the listing's count is reported on its first page only.
    ...(after === undefined && listing.skipped > 0 ? { skipped: { count: listing.skipped, reason: S.skipped } } : {}),
    ...(listing.complete
      ? {}
      : { readOutcome: { scope: "incomplete" as const, endReason: FIRESTORE_LISTING_SENTENCES.idCap } }),
  };
}

/** The smallest string above every id starting with `partial` in code point order; none after U+10FFFF. */
export function idSuccessor(partial: string): string | null {
  const points = Array.from(partial);
  const last = (points.pop() as string).codePointAt(0) as number;
  if (last === 0x10ffff) return null;
  return points.join("") + String.fromCodePoint(last === 0xd7ff ? 0xe000 : last + 1);
}

function malformedListing(): QueryError {
  return new QueryError(FIRESTORE_LISTING_SENTENCES.malformed, FIRESTORE_TYPE);
}

/** The expired-listing sentence for a page token Google no longer takes; every other failure stays as mapped. */
function levelFailure(error: unknown, sentToken: boolean): unknown {
  const google = googleErrorOf(error);
  if (sentToken && google?.httpStatus === 400 && google.status === "INVALID_ARGUMENT")
    return refuse(FIRESTORE_CURSOR_SENTENCES.expired);
  return error;
}

function readDocumentPage(answer: unknown): {
  readonly documents: readonly RestDocument[];
  readonly next: string | undefined;
} {
  if (!isRecord(answer)) throw malformedListing();
  const { documents, nextPageToken } = answer;
  if (
    documents !== undefined &&
    !(Array.isArray(documents) && documents.every((entry) => isRecord(entry) && typeof entry.name === "string"))
  )
    throw malformedListing();
  if (nextPageToken !== undefined && typeof nextPageToken !== "string") throw malformedListing();
  return { documents: (documents ?? []) as RestDocument[], next: nextPageToken === "" ? undefined : nextPageToken };
}

/** The page token and the owed folder a collection level's cursor carries; an id level's cursor is refused. */
function collectionPosition(cursor: LevelCursor | null): { readonly token?: string; readonly owed?: string } {
  if (cursor === null) return {};
  if ("a" in cursor) throw refuse(FIRESTORE_CURSOR_SENTENCES.malformed);
  return { ...("t" in cursor ? { token: cursor.t } : {}), ...(cursor.o === undefined ? {} : { owed: cursor.o }) };
}

/** One folder or key directly under the level: a non-empty id with no separator after the level's prefix. */
function oneSegmentAfter(entry: string, levelPrefix: string): boolean {
  const id = entry.slice(levelPrefix.length);
  return entry.startsWith(levelPrefix) && id !== "" && !id.includes("/");
}

function skippedOf(count: number): Pick<KeyScanPage, "skipped"> {
  return count > 0 ? { skipped: { count, reason: S.skipped } } : {};
}

/**
 * The id of a document an answer listed directly under `collection`, and whether the id rules refuse it, so it is
 * counted and not listed; every other name is `collectionChildId`'s to refuse, which reads a refused id as foreign.
 */
function listedChild(
  client: FirestoreClient,
  collection: readonly string[],
  name: string,
): { readonly id: string; readonly refused: boolean } {
  const parentName = `${fullDocumentName(client.target, collection)}/`;
  const raw = name.startsWith(parentName) ? name.slice(parentName.length) : "";
  if (raw !== "" && !raw.includes("/") && idRefusal(raw, "document") !== null) return { id: raw, refused: true };
  return { id: collectionChildId(client.target, collection, name), refused: false };
}

/** One page of a collection level with no typed id: one `listDocuments` at most. */
async function scanCollectionPage(
  request: LevelRequest,
  client: FirestoreClient,
  signal: AbortSignal,
  base: CallBase,
): Promise<KeyScanPage> {
  const { token, owed } = collectionPosition(request.cursor);
  const collection = request.complete;
  const levelPrefix = `${collection.join("/")}/`;
  const keys: string[] = [];
  const prefixes: string[] = [];
  let room = request.count;
  if (owed !== undefined) {
    if (!oneSegmentAfter(owed.slice(0, -1), levelPrefix)) throw refuse(FIRESTORE_CURSOR_SENTENCES.malformed);
    prefixes.push(owed);
    room -= 1;
  }
  let next = token;
  let owedOut: string | undefined;
  let skipped = 0;
  if (room > 0) {
    const pageSize = Math.min(LIMITS.collectionPageSizeUnmasked, Math.max(1, Math.floor(room / 2)));
    let answer: unknown;
    try {
      answer = await client.send(
        {
          kind: "listDocuments",
          parent: collection.slice(0, -1),
          collectionId: collection[collection.length - 1],
          pageSize,
          showMissing: true,
          ...(token === undefined ? {} : { pageToken: token }),
        },
        { signal, context: callContext(client, base, "listing", "keys") },
      );
    } catch (error) {
      throw levelFailure(error, token !== undefined);
    }
    const listing = readDocumentPage(answer);
    if (listing.documents.length > pageSize) throw malformedListing();
    next = listing.next;
    for (const document of listing.documents) {
      const { id, refused } = listedChild(client, collection, document.name);
      if (refused) {
        skipped += 1;
        continue;
      }
      const key = `${levelPrefix}${id}`;
      if (document.createTime !== undefined) {
        keys.push(key);
        room -= 1;
        // Only a page of room 1 asks for one document whose pair cannot fit, so this is that page's last entry.
        if (room === 0) {
          owedOut = `${key}/`;
          break;
        }
      }
      prefixes.push(`${key}/`);
      room -= 1;
    }
  }
  const p = request.pattern;
  const cursor =
    owedOut !== undefined
      ? encodeLevelCursor(next === undefined ? { v: 1, p, o: owedOut } : { v: 1, p, t: next, o: owedOut })
      : next !== undefined
        ? encodeLevelCursor({ v: 1, p, t: next })
        : "0";
  return { keys, prefixes, cursor, types: {}, total: 0, ...skippedOf(skipped) };
}

function nameFilter(op: "GREATER_THAN_OR_EQUAL" | "LESS_THAN", referenceValue: string): object {
  return { fieldFilter: { field: { fieldPath: "__name__" }, op, value: { referenceValue } } };
}

/** One page of a collection level with a typed id: one names-only `runQuery` at most. */
async function scanPartialPage(
  request: LevelRequest,
  client: FirestoreClient,
  signal: AbortSignal,
  base: CallBase,
): Promise<KeyScanPage> {
  const after = request.cursor === null ? undefined : afterOf(request.cursor);
  if (request.partial.startsWith("__id")) throw refuse(S.numericPartial);
  const collection = request.complete;
  const parent = collection.slice(0, -1);
  if (parent.length > 0 && verbParentHasColon(parent)) throw refuse(S.colonSearch);
  const levelPrefix = `${collection.join("/")}/`;
  const outcome = { readOutcome: { scope: "unknown" as const, endReason: S.partialUnknown } };
  const keys: string[] = [];
  const prefixes: string[] = [];
  let room = request.count;
  // `resume` is the entry the next page starts after: a folder when its pair is done, a key when its folder is owed.
  let resume: string | undefined;
  let from: string | undefined;
  if (after !== undefined) {
    const key = after.endsWith("/") ? after.slice(0, -1) : after;
    if (!oneSegmentAfter(key, levelPrefix) || !key.startsWith(levelPrefix + request.partial))
      throw refuse(FIRESTORE_CURSOR_SENTENCES.malformed);
    if (!after.endsWith("/")) {
      prefixes.push(`${key}/`);
      room -= 1;
    }
    from = key;
    resume = `${key}/`;
  }
  if (room === 0)
    return {
      keys,
      prefixes,
      cursor: encodeLevelCursor({ v: 1, p: request.pattern, a: resume as string }),
      types: {},
      total: 0,
      ...outcome,
    };
  const limit = Math.min(LIMITS.collectionPageSizeMax, Math.max(1, Math.floor(room / 2)));
  const nameOf = (id: string): string => fullDocumentName(client.target, [...collection, id]);
  const upper = idSuccessor(request.partial);
  const filters = [
    nameFilter("GREATER_THAN_OR_EQUAL", nameOf(request.partial)),
    ...(upper === null ? [] : [nameFilter("LESS_THAN", nameOf(upper))]),
  ];
  const structuredQuery = {
    select: { fields: [{ fieldPath: "__name__" }] },
    from: [{ collectionId: collection[collection.length - 1] }],
    where: filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } },
    orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    ...(from === undefined
      ? {}
      : { startAt: { values: [{ referenceValue: fullDocumentName(client.target, from.split("/")) }], before: false } }),
    limit,
  };
  // No page token is sent here, so a failure stays as the transport mapped it (keys surface included).
  const answer = await client.send(
    { kind: "runQuery", parent, body: { structuredQuery } },
    { signal, context: callContext(client, base, "listing", "keys") },
  );
  const { documents } = readQueryStream(answer);
  if (documents.length > limit) throw malformedListing();
  let skipped = 0;
  let stopped = false;
  for (const document of documents) {
    const { id, refused } = listedChild(client, collection, document.name);
    // Past U+10FFFF the range has no upper bound, so the first id outside the partial ends the walk.
    if (!id.startsWith(request.partial)) {
      stopped = true;
      break;
    }
    const key = `${levelPrefix}${id}`;
    resume = `${key}/`;
    if (refused) {
      skipped += 1;
      continue;
    }
    keys.push(key);
    room -= 1;
    if (room === 0) {
      resume = key;
      break;
    }
    prefixes.push(`${key}/`);
    room -= 1;
  }
  const more = !stopped && documents.length === limit;
  const cursor =
    resume !== undefined && (more || !resume.endsWith("/"))
      ? encodeLevelCursor({ v: 1, p: request.pattern, a: resume })
      : "0";
  return { keys, prefixes, cursor, types: {}, total: 0, ...skippedOf(skipped), ...outcome };
}

/** One page of the Keys panel: every refusal before any request, then one listing at most. */
export async function scanFirestoreLevel(
  options: KeyScanOptions,
  client: FirestoreClient,
  signal: AbortSignal,
  base: CallBase,
): Promise<KeyScanPage> {
  const request = readLevelRequest(options);
  if (request.complete.length % 2 === 0) return scanIdLevel(request, client, signal, base);
  return request.partial === ""
    ? scanCollectionPage(request, client, signal, base)
    : scanPartialPage(request, client, signal, base);
}
