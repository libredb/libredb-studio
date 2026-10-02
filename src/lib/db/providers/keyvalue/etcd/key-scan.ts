/**
 * The Keys panel's pages over etcd (spec 4.6): a page is keys_only `Range` reads from the cursor to the
 * end of the walked range, every page of a walk pinned to its first page's revision, and, for a user who
 * is not root, over the pieces of that range it may read and nothing outside them (spec 4.7).
 *
 * The cursor is this provider's own and opaque to the panel: `k:`, the next key in base64url, the pinned
 * revision, the walk's total and the walk's digest, so a page resumed minutes later reads at the revision
 * the walk began at and answers the total its first page counted. The digest is of the pieces the walk
 * reads, so a cursor goes on only over those pieces: grants an admin changed between pages, which the
 * provider reads again (spec 4.7, R13 D10), or another prefix, would clip the walk to pieces its total did
 * not count, and the cursor is refused with the instruction to start the walk again. A key that is not
 * UTF-8 text has no name a row could carry, so it is counted in `skipped` and never listed with
 * replacement characters (plan Review Focus 1), and a compaction that overtook the pinned revision tells
 * the reader to start the walk again (plan Review Focus 2).
 */
import { createHash } from "node:crypto";
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { DatabaseType, KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import {
  type EtcdByteRange,
  type EtcdBytes,
  type EtcdClient,
  EtcdError,
  type EtcdInt64,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
} from "./client";
import { etcdWords, toProviderError } from "./errors";
import { ALL_KEYS, decodeUtf8, encodeKey, INT64_MAX, prefixRangeEnd, rangesIntersect } from "./keys";
import { type EtcdSurfaceContext, surfaceErrorContext } from "./objects";
import { type AccessScope, clipToScope, describeRange } from "./permissions";

const PROVIDER: DatabaseType = "etcd";

/**
 * Spec 4.6: a `/` convention, a cursor only this provider reads, a literal prefix, and a total the walk
 * counts. The two counts were kept by Task 22's measurement on 2026-10-01 (KE3b: in a flat directory
 * of 200,000 keys, a page of 500 keys took 7 ms and one of 1,000 keys 8 ms).
 */
export const ETCD_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  defaultCount: 500,
  maxCount: 1_000,
  separator: "/",
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "walk",
});

/** The walk's digest is SHA-256 in base64url, 43 characters. */
const CURSOR = /^k:([A-Za-z0-9_-]+):([1-9][0-9]*):(0|[1-9][0-9]*):([A-Za-z0-9_-]{43})$/;
/**
 * The digits of the largest revision or count etcd holds (int64, keys.ts): a longer number was not
 * written here, and is refused by its length before a number is built from text the caller sent.
 */
const INT64_DIGITS = INT64_MAX.toString().length;

const SKIPPED_REASON =
  "they are not UTF-8 text, so no name a row can carry addresses them; read them with a typed get, which shows them in base64";

/** "k:<base64url of the next key>:<pinned revision>:<the walk's total>:<the walk's digest>" (spec 4.6). */
export function encodeScanCursor(nextKey: EtcdBytes, revision: EtcdInt64, total: EtcdInt64, digest: string): string {
  return `k:${Buffer.from(nextKey).toString("base64url")}:${revision}:${total}:${digest}`;
}

/** "0" is "start"; undefined for a cursor this provider did not write. */
export function decodeScanCursor(cursor: string):
  | {
      readonly nextKey: EtcdBytes;
      readonly revision: EtcdInt64;
      readonly total: EtcdInt64;
      readonly digest: string;
    }
  | "start"
  | undefined {
  if (cursor === "0") return "start";
  const match = CURSOR.exec(cursor);
  if (match === null) return undefined;
  if (match[2].length > INT64_DIGITS || match[3].length > INT64_DIGITS) return undefined;
  if (BigInt(match[2]) > INT64_MAX || BigInt(match[3]) > INT64_MAX) return undefined;
  const nextKey = new Uint8Array(Buffer.from(match[1], "base64url"));
  // Only the one spelling this module writes: base64url decoding forgives trailing bits, so two
  // spellings could name one key.
  if (Buffer.from(nextKey).toString("base64url") !== match[1]) return undefined;
  return { nextKey, revision: match[2], total: match[3], digest: match[4] };
}

/** The range a pattern names: every key under the prefix, byte for byte, or the whole key space. */
function walkedRange(pattern: string | undefined): EtcdByteRange {
  if (pattern === undefined || pattern === "") return ALL_KEYS;
  const prefix = encodeKey(pattern);
  if (decodeUtf8(prefix) !== pattern) {
    throw new DatabaseConfigError(
      "The prefix holds a character that is not text, so it names no exact bytes: type it again.",
      PROVIDER,
    );
  }
  return { key: prefix, rangeEnd: prefixRangeEnd(prefix) };
}

/** A digest of the pieces a walk reads, each its key and range end in base64url, in byte order. */
function piecesDigest(pieces: readonly EtcdByteRange[]): string {
  const spelled = pieces.map((piece) => [
    Buffer.from(piece.key).toString("base64url"),
    piece.rangeEnd === undefined ? null : Buffer.from(piece.rangeEnd).toString("base64url"),
  ]);
  return createHash("sha256").update(JSON.stringify(spelled)).digest("base64url");
}

/**
 * The digest a cursor of a walk over `pattern` carries, for a connection that may read `readable`: of
 * the pieces of the walked range it may read (spec 4.6, 4.7).
 */
export function walkDigest(pattern: string | undefined, readable: AccessScope): string {
  return piecesDigest(clipToScope(walkedRange(pattern), readable));
}

/** A read of `piece` from `from` on. */
function from(piece: EtcdByteRange, key: EtcdBytes): EtcdByteRange {
  return piece.rangeEnd === undefined ? { key } : { key, rangeEnd: piece.rangeEnd };
}

/** The first key after `key` in byte order: `key` with one 0x00 byte appended. */
function after(key: EtcdBytes): EtcdBytes {
  const next = new Uint8Array(key.length + 1);
  next.set(key);
  return next;
}

async function pageRead(
  client: Pick<EtcdClient, "range">,
  context: EtcdSurfaceContext,
  request: EtcdRangeRequest,
): Promise<EtcdRangeResponse> {
  try {
    return await client.range(request, { signal: context.signal });
  } catch (error) {
    if (request.revision !== undefined && error instanceof EtcdError && error.category === "compacted") {
      throw new QueryError(
        `A compaction overtook this walk of the keys: etcd compacted revision ${request.revision}, the revision its pages are pinned to, after the walk began, so it cannot go on from this page. Start the walk again.${etcdWords(error)}`,
        PROVIDER,
      );
    }
    throw toProviderError(error, surfaceErrorContext(context, "Keys panel walk", { range: describeRange(request) }));
  }
}

interface Walk {
  /** The pieces of the walked range this connection may read, in byte order. */
  readonly pieces: readonly EtcdByteRange[];
  /** Their digest, which every cursor of the walk carries. */
  readonly digest: string;
  readonly count: number;
  readonly revision: EtcdInt64;
  readonly total: EtcdInt64;
}

function page(keys: string[], skipped: number, cursor: string, total: EtcdInt64): KeyScanPage {
  return {
    keys,
    cursor,
    // A published number: the key count of one etcd is far below 2^53.
    total: Number(total),
    types: {},
    ...(skipped === 0 ? {} : { skipped: { count: skipped, reason: SKIPPED_REASON } }),
  };
}

/**
 * One page's keys from `first` on, taken from the pieces after it while the page has room, and the cursor
 * after them: inside the piece the last read stopped in, at the start of the next piece, or "0".
 */
async function fill(
  client: Pick<EtcdClient, "range">,
  context: EtcdSurfaceContext,
  walk: Walk,
  index: number,
  first: EtcdRangeResponse,
): Promise<KeyScanPage> {
  const keys: string[] = [];
  let skipped = 0;
  let answer = first;
  let at = index;
  for (;;) {
    for (const kv of answer.kvs) {
      const name = decodeUtf8(kv.key);
      if (name === undefined) skipped += 1;
      else keys.push(name);
    }
    if (answer.more) {
      // The cursor goes on after the page's last key, so a page that says more follow and holds none has no place to
      // go on from (keys.ts stepPrefixWalk refuses the same answer).
      if (answer.kvs.length === 0)
        throw new RangeError("A keys_only page that says more keys follow holds at least one key");
      const last = answer.kvs[answer.kvs.length - 1].key;
      return page(keys, skipped, encodeScanCursor(after(last), walk.revision, walk.total, walk.digest), walk.total);
    }
    at += 1;
    if (at === walk.pieces.length) return page(keys, skipped, "0", walk.total);
    const next = walk.pieces[at];
    const room = walk.count - keys.length - skipped;
    if (room === 0) {
      return page(keys, skipped, encodeScanCursor(next.key, walk.revision, walk.total, walk.digest), walk.total);
    }
    // oxlint-disable-next-line no-await-in-loop -- the page goes on in the next readable piece while it has room.
    answer = await pageRead(client, context, {
      ...from(next, next.key),
      limit: room,
      keysOnly: true,
      revision: walk.revision,
    });
  }
}

/** What a page asks for, read from its options before any request (spec 4.6). */
interface PageRequest {
  /** "start", or a cursor this provider wrote. */
  readonly cursor: NonNullable<ReturnType<typeof decodeScanCursor>>;
  /** The range the pattern names, before the grants clip it (spec 4.7). */
  readonly range: EtcdByteRange;
}

/**
 * A page's options as the walk reads them, each refusal that needs neither a request nor the grants raised here
 * (spec 4.6, 5.6, R11 CF-18): a `database`, a `count` outside its bounds, a cursor this provider did not write,
 * and a prefix that is not text. The provider reads them before its walk reads the grants, so none of these
 * refusals sends a request.
 */
export function readKeyScanOptions(options: KeyScanOptions): PageRequest {
  if (options.database !== undefined) {
    throw new DatabaseConfigError(
      'etcd walks one key space and has no numbered database, so "database" names nothing: leave it out.',
      PROVIDER,
    );
  }
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > ETCD_KEY_SCAN.maxCount) {
    throw new DatabaseConfigError(
      `"count" must be a whole number from 1 to ${ETCD_KEY_SCAN.maxCount.toLocaleString("en-US")}.`,
      PROVIDER,
    );
  }
  const cursor = decodeScanCursor(options.cursor);
  if (cursor === undefined) {
    throw new DatabaseConfigError("This cursor was not written by the etcd provider: start the walk again.", PROVIDER);
  }
  return { cursor, range: walkedRange(options.pattern) };
}

/** One page of the Keys panel's walk (spec 4.6, 4.7); every refusal is raised before any request. */
export async function scanEtcdKeysPage(
  client: Pick<EtcdClient, "range">,
  context: EtcdSurfaceContext,
  options: KeyScanOptions,
): Promise<KeyScanPage> {
  const { cursor, range } = readKeyScanOptions(options);
  const pieces = clipToScope(range, context.readable);
  const digest = piecesDigest(pieces);

  if (cursor !== "start") {
    // A cursor goes on only over the pieces its first page counted: grants read again since then, or
    // another prefix, give other pieces, which its total does not count (spec 4.6, 4.7).
    const index = pieces.findIndex((piece) => rangesIntersect({ key: cursor.nextKey }, piece));
    if (cursor.digest !== digest || index === -1) {
      throw new DatabaseConfigError(
        "This cursor does not continue a walk of the keys this connection may read under this prefix: start the walk again.",
        PROVIDER,
      );
    }
    const answer = await pageRead(client, context, {
      ...from(pieces[index], cursor.nextKey),
      limit: options.count,
      keysOnly: true,
      revision: cursor.revision,
    });
    const walk = { pieces, digest, count: options.count, revision: cursor.revision, total: cursor.total };
    return fill(client, context, walk, index, answer);
  }

  if (pieces.length === 0) return page([], 0, "0", "0");
  const first = await pageRead(client, context, {
    ...from(pieces[0], pieces[0].key),
    limit: options.count,
    keysOnly: true,
  });
  const revision = first.header.revision;
  // The first page's count is its whole range's, whatever the limit (SRC rpc.proto, RangeResponse.count);
  // every other readable piece is counted once, at the pinned revision, so every page answers the walk's total (KE3).
  let total = BigInt(first.count);
  for (const piece of pieces.slice(1)) {
    // oxlint-disable-next-line no-await-in-loop -- one count_only per piece, each at the pinned revision.
    const counted = await pageRead(client, context, { ...from(piece, piece.key), limit: 1, countOnly: true, revision });
    total += BigInt(counted.count);
  }
  return fill(client, context, { pieces, digest, count: options.count, revision, total: String(total) }, 0, first);
}
