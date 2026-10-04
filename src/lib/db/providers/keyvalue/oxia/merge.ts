/**
 * The k-way merge of per-shard answers and its exactness bound (SB1-7.5), and the choice of one answer among the
 * shards for a comparison get (SB1-7.6).
 *
 * Pure. A server defect (a shard that lists one key twice, an answer that lacks the key it must carry) is a
 * `RangeError`, which `walks.ts` reports as a malformed answer.
 */
import type { OxiaComparison, OxiaRecord, OxiaShard } from "./client";
import { OXIA_INTERNAL_PREFIX } from "./constants";
import { compareBytes, encodeHierarchical, encodeNatural, type KeyOrder, keyComparator } from "./order";

export interface ShardKeys {
  readonly keys: readonly string[];
  readonly complete: boolean;
}

export interface ShardRecords<T extends { readonly key: string }> {
  readonly records: readonly T[];
  readonly complete: boolean;
}

export interface ShardAnswer {
  readonly shard: OxiaShard;
  readonly record: OxiaRecord;
}

/** One shard's answer as the private merge reads it. */
interface MergeInput<T> {
  readonly items: readonly T[];
  readonly complete: boolean;
}

/** A merged page, or a stall: an incomplete shard that answered nothing. */
type MergeOutput<T> = { readonly items: readonly T[]; readonly more: boolean } | { readonly stalled: true };

/** A shard's read position: the encoded key of its head item. */
interface Cursor {
  readonly shard: number;
  position: number;
  head: Uint8Array;
}

/** A binary min-heap of shard cursors by encoded head; equal heads by shard index, so the merge is deterministic. */
class CursorHeap {
  private readonly cursors: Cursor[] = [];

  get size(): number {
    return this.cursors.length;
  }

  peek(): Cursor | undefined {
    return this.cursors[0];
  }

  push(cursor: Cursor): void {
    this.cursors.push(cursor);
    let i = this.cursors.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): Cursor {
    const top = this.cursors[0];
    const last = this.cursors.pop() as Cursor;
    if (this.cursors.length > 0) {
      this.cursors[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let least = i;
        if (left < this.cursors.length && this.less(left, least)) least = left;
        if (right < this.cursors.length && this.less(right, least)) least = right;
        if (least === i) break;
        this.swap(i, least);
        i = least;
      }
    }
    return top;
  }

  private less(a: number, b: number): boolean {
    const order = compareBytes(this.cursors[a].head, this.cursors[b].head);
    return order < 0 || (order === 0 && this.cursors[a].shard < this.cursors[b].shard);
  }

  private swap(a: number, b: number): void {
    const held = this.cursors[a];
    this.cursors[a] = this.cursors[b];
    this.cursors[b] = held;
  }
}

/**
 * Merges the shards' items in the order's sequence, emitting only items at or below the bound: the least last key of
 * the incomplete shards. A shard cut short may hold keys below another shard's later keys, so nothing above its last
 * key is emitted until it is read further.
 */
function mergeShards<T>(
  shards: readonly MergeInput<T>[],
  key: (item: T) => string,
  order: KeyOrder,
  count: number,
): MergeOutput<T> {
  if (shards.some((shard) => !shard.complete && shard.items.length === 0)) return { stalled: true };
  const encode = order === "hierarchical" ? encodeHierarchical : encodeNatural;
  const encoded = shards.map((shard) => {
    const seen = new Set<string>();
    return shard.items.map((item) => {
      const text = key(item);
      if (seen.has(text)) throw new RangeError("A shard listed one key twice");
      seen.add(text);
      return encode(text);
    });
  });
  let bound: Uint8Array | undefined;
  shards.forEach((shard, i) => {
    if (shard.complete) return;
    const last = encoded[i][encoded[i].length - 1];
    if (bound === undefined || compareBytes(last, bound) < 0) bound = last;
  });
  const heap = new CursorHeap();
  encoded.forEach((keys, shard) => {
    if (keys.length > 0) heap.push({ shard, position: 0, head: keys[0] });
  });
  const items: T[] = [];
  for (let head = heap.peek(); head !== undefined && items.length < count; head = heap.peek()) {
    if (bound !== undefined && compareBytes(head.head, bound) > 0) break;
    const cursor = heap.pop();
    items.push(shards[cursor.shard].items[cursor.position]);
    cursor.position++;
    if (cursor.position < encoded[cursor.shard].length) {
      cursor.head = encoded[cursor.shard][cursor.position];
      heap.push(cursor);
    }
  }
  return { items, more: shards.some((shard) => !shard.complete) || heap.size > 0 };
}

/** A Keys panel or `list` page over the shards' keys (SB1-7.5). */
export function mergePage(
  shards: readonly ShardKeys[],
  order: KeyOrder,
  count: number,
): { readonly keys: readonly string[]; readonly more: boolean } | { readonly stalled: true } {
  const merged = mergeShards(
    shards.map((shard) => ({ items: shard.keys, complete: shard.complete })),
    (key) => key,
    order,
    count,
  );
  return "stalled" in merged ? merged : { keys: merged.items, more: merged.more };
}

/** A `range-scan` page over the shards' records (SB1-7.5): the records passed in, merged by key. */
export function mergeRecords<T extends { readonly key: string }>(
  shards: readonly ShardRecords<T>[],
  order: KeyOrder,
  count: number,
): { readonly records: readonly T[]; readonly more: boolean } | { readonly stalled: true } {
  const merged = mergeShards(
    shards.map((shard) => ({ items: shard.records, complete: shard.complete })),
    (record) => record.key,
    order,
    count,
  );
  return "stalled" in merged ? merged : { records: merged.items, more: merged.more };
}

/** The text an answer sorts by among the shards. */
function sortText(record: OxiaRecord, secondaryIndexName: string | undefined): string {
  if (record.key === undefined) throw new RangeError("An OK answer carries no key");
  if (secondaryIndexName === undefined) return record.key;
  if (record.secondaryIndexKey === undefined) throw new RangeError("An index answer carries no secondary key");
  return `${OXIA_INTERNAL_PREFIX}idx/${secondaryIndexName}/${record.secondaryIndexKey}\u0001${goPathEscape(record.key)}`;
}

/**
 * The answer of a comparison get across the shards, each shard having answered over its own keys (SB1-7.6): the
 * greatest for FLOOR and LOWER, the least for CEILING and HIGHER, and with an index for EQUAL too; `undefined` when
 * every shard missed.
 *
 * Without an index the answers sort by the namespace's encoder over their keys. With one they sort by the entry the
 * server itself stores, its `secondaryIdxFormat` at v0.16.10 (`__oxia/idx/<index>/<secondary key>\x01<escaped primary
 * key>`), under the same encoder: `CompareWithSlash` is not the order any namespace sorts by, so it is not used.
 */
export function selectComparison(
  comparison: OxiaComparison,
  answers: readonly ShardAnswer[],
  order: KeyOrder,
  secondaryIndexName?: string,
): ShardAnswer | undefined {
  if (secondaryIndexName === undefined && comparison === "EQUAL") {
    throw new RangeError("An EQUAL get without an index is answered by one shard and is never selected across shards");
  }
  const found = answers
    .filter((answer) => answer.record.status === "OK")
    .map((answer) => ({ answer, text: sortText(answer.record, secondaryIndexName) }));
  if (found.length === 0) return undefined;
  const cmp = keyComparator(order);
  const greatest = comparison === "FLOOR" || comparison === "LOWER";
  let chosen = found[0];
  for (const candidate of found.slice(1)) {
    const sign = cmp(candidate.text, chosen.text);
    if (greatest ? sign > 0 : sign < 0) chosen = candidate;
  }
  return chosen.answer;
}

/** The bytes Go's `url.PathEscape` keeps: the unreserved characters and `$&+:=@`. */
function keptByPathEscape(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    "-_.~$&+:=@".includes(String.fromCharCode(byte))
  );
}

const utf8 = new TextEncoder();

/** Go's `url.PathEscape`, over the UTF-8 bytes: every byte it does not keep is `%` and two upper-case hex digits. */
export function goPathEscape(text: string): string {
  let escaped = "";
  for (const byte of utf8.encode(text)) {
    escaped += keptByPathEscape(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return escaped;
}
