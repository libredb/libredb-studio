/**
 * The Keys panel's pages over Oxia (SB2-8): a walk of the namespace in its own key order, resumed by an inclusive
 * cursor that carries the order it was cut under (SB1-7.9).
 *
 * Composed from the walks with no range logic of its own (SB1-8.5a): the first page of a walk with no pattern is the
 * top-level folders discovery found, sorted by the order's encoder, then the full walk's first keys, each key once
 * and never more than `count`; every later page, and every page of a prefix, is the walk alone. Oxia publishes no key
 * count and pins no revision, so a page answers no total (`totalScope: "none"`) and no value types; a capped discovery
 * is no `skipped`, because it left out no key it read (SB2-12 D6).
 */
import { DatabaseConfigError, QueryError } from "@/lib/db/errors";
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import type { OxiaCallOptions, OxiaKeysAnswer } from "./client";
import { OXIA_INTERNAL_KEY_SENTENCE } from "./commands";
import {
  OXIA_CURSOR_KEY_MAX_BYTES,
  OXIA_INTERNAL_PREFIX,
  OXIA_KEY_SCAN_DEFAULT_COUNT,
  OXIA_KEY_SCAN_MAX_COUNT,
  OXIA_TYPE,
} from "./constants";
import { decodeOxiaCursor, encodeOxiaCursor, OXIA_CURSOR_FOREIGN_REFUSAL, OXIA_CURSOR_ORDER_REFUSAL } from "./cursor";
import { hasLoneSurrogate, keyComparator } from "./order";
import { discoverTopNodes, fullWalkPage, type OxiaSurface, prefixWalkPage } from "./walks";

/** SB2-8.1: etcd's two counts, a `/` convention, a cursor only this provider reads, a literal prefix, no count. */
export const OXIA_KEY_SCAN: KeyScanCapability = Object.freeze<KeyScanCapability>({
  defaultCount: OXIA_KEY_SCAN_DEFAULT_COUNT,
  maxCount: OXIA_KEY_SCAN_MAX_COUNT,
  separator: "/",
  cursor: "opaque",
  pattern: "prefix",
  totalScope: "none",
});

const count = (n: number): string => n.toLocaleString("en-US");

/** Ruling R6: the cursor decoder refuses a key longer than the bound, so a page never writes a cursor for one. */
export const OXIA_CURSOR_KEY_TOO_LONG_SENTENCE =
  `A key on this page is longer than ${count(OXIA_CURSOR_KEY_MAX_BYTES)} bytes, so the Keys panel cannot page past it; ` +
  "read the keys after it in the editor with list --key-min.";

/** SB2-8.2: the options a page reads, each refused before any call. */
export function readOxiaKeyScanOptions(options: KeyScanOptions): {
  readonly cursor: string;
  readonly prefix?: string;
  readonly count: number;
} {
  if (!Number.isInteger(options.count) || options.count < 1 || options.count > OXIA_KEY_SCAN_MAX_COUNT)
    throw new DatabaseConfigError(`A page holds 1 to ${count(OXIA_KEY_SCAN_MAX_COUNT)} keys.`, OXIA_TYPE);
  if (options.database !== undefined)
    throw new DatabaseConfigError("An Oxia connection reads one namespace, so a page names no database.", OXIA_TYPE);
  const prefix = options.pattern === undefined || options.pattern === "" ? undefined : options.pattern;
  if (prefix?.startsWith(OXIA_INTERNAL_PREFIX)) throw new DatabaseConfigError(OXIA_INTERNAL_KEY_SENTENCE, OXIA_TYPE);
  if (prefix !== undefined && hasLoneSurrogate(prefix))
    throw new DatabaseConfigError(
      "The prefix holds a character that is not text, so it names no exact key: type it again.",
      OXIA_TYPE,
    );
  return { cursor: options.cursor, ...(prefix === undefined ? {} : { prefix }), count: options.count };
}

/** SB2-8.2: one page of the walk, composed with discovery on the first page of a walk with no pattern. */
export async function scanOxiaKeysPage(
  surface: OxiaSurface,
  options: KeyScanOptions,
  call: OxiaCallOptions,
): Promise<KeyScanPage> {
  const read = readOxiaKeyScanOptions(options);
  const cursor = decodeOxiaCursor(read.cursor);
  if (cursor === undefined) throw new DatabaseConfigError(OXIA_CURSOR_FOREIGN_REFUSAL, OXIA_TYPE);
  const snapshot = await surface.snapshot(call);
  const verdict = await surface.order(call);
  if (cursor !== "start" && cursor.order !== verdict.order)
    throw new DatabaseConfigError(OXIA_CURSOR_ORDER_REFUSAL, OXIA_TYPE);
  const order = verdict.order;
  const client = surface.client;
  const resume = cursor === "start" ? {} : { cursor: cursor.lastKey };

  let representatives: readonly string[] = [];
  let walk: OxiaKeysAnswer;
  if (read.prefix !== undefined) {
    walk = await prefixWalkPage(client, snapshot, order, { prefix: read.prefix, count: read.count, ...resume }, call);
  } else if (cursor !== "start") {
    walk = await fullWalkPage(client, snapshot, order, { count: read.count, ...resume }, call);
  } else {
    // The first page: the folders discovery found, in the order's encoder, up to count - 1 of them, then the walk.
    const discovered = await discoverTopNodes(client, snapshot, order, call);
    const kept = [...discovered.representatives].sort(keyComparator(order)).slice(0, read.count - 1);
    walk = await fullWalkPage(client, snapshot, order, { count: Math.max(1, read.count - kept.length) }, call);
    // A representative the walk's page also holds stays only in the walk's part, so each key is listed once.
    const walked = new Set(walk.keys);
    representatives = kept.filter((key) => !walked.has(key));
  }
  const lastKey = walk.keys[walk.keys.length - 1];
  // A cursor past the decoder's bound would be refused on the next page as one this provider did not write.
  if (walk.more && new TextEncoder().encode(lastKey).length > OXIA_CURSOR_KEY_MAX_BYTES)
    throw new QueryError(OXIA_CURSOR_KEY_TOO_LONG_SENTENCE, OXIA_TYPE);
  const next = walk.more ? encodeOxiaCursor({ lastKey, order }) : "0";
  return { keys: [...representatives, ...walk.keys], cursor: next, types: {}, total: 0 };
}
