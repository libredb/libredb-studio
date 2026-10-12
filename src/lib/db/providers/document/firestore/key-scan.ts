/**
 * The Keys panel over Firestore (spec 5.3): one level per page. The pattern is a path relative to `documents`; its
 * complete segments name the level and the text after its last "/" is a partial id that filters it.
 *
 * The root and a document level list collection ids: the whole list is read with `listCollectionIdsSorted` on every
 * page, filtered by the partial, its folders sorted by UTF-8 bytes and paged after the cursor's last entry
 * (start-after), so a list that changes between two pages neither skips nor repeats a folder. Every refusal of the
 * options, the pattern and the cursor comes before any request; a document whose id holds ":" cannot be listed,
 * because a verb request under it is refused, and Part 1's sentence says how to query its subcollections instead.
 * Every request names the `keys` surface, so an answer past its cap gets the panel's own sentence from Part 1.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { FIRESTORE_ERROR_PROVIDER, LIMITS, SENTENCES } from "./constants";
import { decodeLevelCursor, encodeLevelCursor, FIRESTORE_CURSOR_SENTENCES, type LevelCursor } from "./cursor";
import { compareUtf8, idRefusal, verbParentHasColon } from "./names";
import { type CallBase, FIRESTORE_LISTING_SENTENCES, listCollectionIdsSorted } from "./objects";
import type { FirestoreClient } from "./transport";

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
  return new DatabaseConfigError(message, FIRESTORE_ERROR_PROVIDER);
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
