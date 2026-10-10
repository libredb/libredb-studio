/**
 * The Keys panel's pages over S3: one key space whose keys are `<bucket>/<key>`, walked one
 * level at a time under the Keys panel's level contract, or as a plain recursive walk of one bucket.
 *
 * The root level is the bucket list: a pinned connection answers its one folder with no request;
 * otherwise one ListBuckets, whose answer is unpaged on every measured server, de-duplicated and sorted by UTF-8 byte
 * order by the client, then paged here after the cursor's last name (start-after), so a list that changes order
 * between calls neither skips nor repeats. A level inside a bucket is one ListObjectsV2 with `delimiter=/`,
 * its common prefixes the folders and its objects the keys, the server's token wrapped in the cursor envelope. A
 * walk without `level` reads one bucket recursively; at the root it needs a pin. A bucket segment failing
 * the bucket rule is refused before any request, pinned or not, level or plain. A key row's descriptor is
 * its size in words, from the shared `formatBytes`.
 */
import { DatabaseConfigError } from "@/lib/db/errors";
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { formatBytes } from "@/lib/db/utils/pool-manager";
import type { BucketListing, ObjectListing, S3CallOptions, S3Surface } from "./client";
import { S3_KEY_MAX_BYTES, S3_KEY_SCAN_DEFAULT_COUNT, S3_KEY_SCAN_MAX_COUNT, S3_TYPE } from "./constants";
import {
  cursorInScope,
  decodeS3Cursor,
  encodeS3Cursor,
  S3_CURSOR_SENTENCES,
  type S3Cursor,
  type S3CursorScope,
} from "./cursor";
import { bucketAddressRefusal, joinVirtualKey, shownName } from "./names";

export const S3_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  defaultCount: S3_KEY_SCAN_DEFAULT_COUNT,
  maxCount: S3_KEY_SCAN_MAX_COUNT,
  separator: "/",
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "none",
  levels: { rootKind: "bucket" },
});

export const S3_KEY_SCAN_SENTENCES = Object.freeze({
  count: "A page holds 1 to 1,000 entries.",
  database: "An S3 connection walks one key space of buckets and keys, so a page names no database.",
  notText: "The prefix holds a character that is not text, so it names no exact key: type it again.",
  prefixTooLong: "A prefix holds at most 1,024 bytes after the bucket name.",
  bucketPattern: (bucket: string): string =>
    `Studio does not list bucket ${shownName(bucket)}: a bucket it addresses is 1 to 255 letters, digits, dots, hyphens or underscores, starting and ending with a letter or digit.`,
  outsidePin: (pin: string): string => `This connection reads only bucket ${pin}: start the prefix with ${pin}/.`,
  walkNeedsBucket:
    "A walk of keys only reads one bucket: start the prefix with the bucket name and a slash, or set Bucket on the connection.",
  skipped:
    "Names that are not UTF-8 text, and bucket names holding a slash, cannot be shown or opened, so they are counted here and not listed.",
});

export interface ReadScanOptions {
  readonly cursor: string;
  readonly count: number;
  readonly level: boolean;
  /** null at the root level. */
  readonly bucket: string | null;
  /** The S3 prefix (the pattern's key part), or the bucket-name filter at the root level. */
  readonly prefix: string;
}

const utf8 = new TextEncoder();

function refuse(message: string): DatabaseConfigError {
  return new DatabaseConfigError(message, S3_TYPE);
}

/** Every option refusal, in the order the options are read, before any request. */
export function readS3KeyScanOptions(options: KeyScanOptions, pinned?: string): ReadScanOptions {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > S3_KEY_SCAN_MAX_COUNT)
    throw refuse(S3_KEY_SCAN_SENTENCES.count);
  if (options.database !== undefined) throw refuse(S3_KEY_SCAN_SENTENCES.database);
  const pattern = options.pattern ?? "";
  if (!pattern.isWellFormed()) throw refuse(S3_KEY_SCAN_SENTENCES.notText);
  const level = options.level === true;
  const base = { cursor: options.cursor, count: options.count, level };
  const slash = pattern.indexOf("/");
  if (slash < 0) {
    if (level) return { ...base, bucket: null, prefix: pattern };
    if (pinned !== undefined && pattern === "") return { ...base, bucket: pinned, prefix: "" };
    const walk =
      pinned === undefined ? S3_KEY_SCAN_SENTENCES.walkNeedsBucket : S3_KEY_SCAN_SENTENCES.outsidePin(pinned);
    throw refuse(walk);
  }
  const bucket = pattern.slice(0, slash);
  const prefix = pattern.slice(slash + 1);
  if (utf8.encode(prefix).length > S3_KEY_MAX_BYTES) throw refuse(S3_KEY_SCAN_SENTENCES.prefixTooLong);
  if (bucketAddressRefusal(bucket) !== undefined) throw refuse(S3_KEY_SCAN_SENTENCES.bucketPattern(bucket));
  if (pinned !== undefined && bucket !== pinned) throw refuse(S3_KEY_SCAN_SENTENCES.outsidePin(pinned));
  return { ...base, bucket, prefix };
}

function skipped(count: number): Pick<KeyScanPage, "skipped"> {
  return count > 0 ? { skipped: { count, reason: S3_KEY_SCAN_SENTENCES.skipped } } : {};
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

async function rootPage(
  surface: S3Surface,
  read: ReadScanOptions,
  scope: S3CursorScope,
  cursor: S3Cursor | "start",
  call: S3CallOptions,
): Promise<KeyScanPage> {
  const pin = surface.options.pinnedBucket;
  if (pin !== undefined) {
    const prefixes = cursor === "start" && pin.startsWith(read.prefix) ? [`${pin}/`] : [];
    return { keys: [], prefixes, cursor: "0", types: {}, total: 0 };
  }
  let listing: BucketListing;
  try {
    listing = await surface.client.listBuckets(call);
  } catch (error) {
    throw surface.fail(error, "ListBuckets");
  }
  const after = cursor === "start" ? undefined : cursor.after;
  const names = listing.buckets
    .map((bucket) => bucket.name)
    .filter((name) => name.startsWith(read.prefix) && (after === undefined || byteOrder(name, after) > 0));
  const page = names.slice(0, read.count);
  const next = names.length > read.count ? encodeS3Cursor({ ...scope, after: page[page.length - 1] }) : "0";
  return {
    keys: [],
    prefixes: page.map((name) => `${name}/`),
    cursor: next,
    types: {},
    total: 0,
    // The walk adds up skipped across its pages, so the names the filter keeps are counted on its first page only.
    ...skipped(cursor === "start" ? listing.invalidNames.filter((name) => name.startsWith(read.prefix)).length : 0),
  };
}

async function listingPage(
  surface: S3Surface,
  read: ReadScanOptions,
  bucket: string,
  scope: S3CursorScope,
  cursor: S3Cursor | "start",
  call: S3CallOptions,
): Promise<KeyScanPage> {
  let listing: ObjectListing;
  try {
    listing = await surface.client.listObjectsV2(
      {
        bucket,
        prefix: read.prefix,
        maxKeys: read.count,
        ...(read.level ? { delimiter: "/" as const } : {}),
        ...(cursor === "start" ? {} : { continuationToken: cursor.token as string }),
      },
      call,
    );
  } catch (error) {
    throw surface.fail(error, "ListObjectsV2");
  }
  const keys = listing.keys.map((entry) => joinVirtualKey(bucket, entry.key));
  const types = Object.fromEntries(
    listing.keys.map((entry) => [joinVirtualKey(bucket, entry.key), formatBytes(entry.size)]),
  );
  // The client refuses a truncated page with no token (E21), so a truncated listing carries one.
  const next = listing.isTruncated ? encodeS3Cursor({ ...scope, token: listing.nextToken as string }) : "0";
  return {
    keys,
    ...(read.level ? { prefixes: listing.prefixes.map((prefix) => joinVirtualKey(bucket, prefix)) } : {}),
    cursor: next,
    types,
    total: 0,
    ...skipped(listing.undecodable),
  };
}

/** Every refusal a page gives before any request: the options, then the cursor's spelling and scope. */
export function readS3KeyScanRequest(
  options: KeyScanOptions,
  pinned?: string,
): { read: ReadScanOptions; scope: S3CursorScope; cursor: S3Cursor | "start" } {
  const read = readS3KeyScanOptions(options, pinned);
  const scope: S3CursorScope = { bucket: read.bucket, prefix: read.prefix, level: read.level };
  const cursor = decodeS3Cursor(read.cursor);
  if (cursor === undefined) throw refuse(S3_CURSOR_SENTENCES.foreign);
  if (cursor !== "start" && !cursorInScope(cursor, scope)) throw refuse(S3_CURSOR_SENTENCES.scope);
  return { read, scope, cursor };
}

/** One page of the Keys panel: options and cursor refused before any request, then one server call at most. */
export async function scanS3KeysPage(
  surface: S3Surface,
  options: KeyScanOptions,
  call: S3CallOptions,
): Promise<KeyScanPage> {
  const { read, scope, cursor } = readS3KeyScanRequest(options, surface.options.pinnedBucket);
  return read.bucket === null
    ? rootPage(surface, read, scope, cursor, call)
    : listingPage(surface, read, read.bucket, scope, cursor, call);
}
