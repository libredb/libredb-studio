/**
 * The Oxia key order, pure and browser-safe (SB1-7.1 to SB1-7.4, SB1-8.1, SB1-8.2).
 *
 * The two server encoders are a port of `common/compare/encode.go` at v0.16.10, by way of the J4 prototype
 * `keyorder.mjs`: a namespace sorts its keys by the bytes one of them writes, and every range a walk reads is a range
 * of those bytes. This module holds the order probe's decisions (the calls are `walks.ts`'s), the children, root and
 * prefix ranges every walk reads, and the discovery probes.
 */
import type { OxiaGet, OxiaRange } from "./client";
import { OXIA_INTERNAL_PREFIX } from "./constants";

/** The "/" byte (common/compare/encode.go at v0.16.10). */
const SLASH = 0x2f;
/**
 * The greatest byte, 0xff: the hierarchical encoder writes it for every "/", and the natural encoder for an internal
 * key's first two bytes (common/compare/encode.go at v0.16.10).
 */
const ENCODED_SLASH = 0xff;
/** The level bit the hierarchical encoder sets for an internal key that holds a "/" (common/compare/encode.go at v0.16.10). */
const INTERNAL_LEVEL_BIT = 0x8000;
/** The slash count of the order probe's FLOOR key, above every level a key can reach (common/compare/encode.go at v0.16.10). */
const PROBE_DEPTH = 0x8000;

const utf8 = new TextEncoder();

export type KeyOrder = "hierarchical" | "natural";
export type OrderLearnedBy = "ceiling-probe" | "decisive-list" | "pair-sample" | "assumed" | "empty";
export interface OrderVerdict {
  readonly order: KeyOrder;
  readonly learnedBy: OrderLearnedBy;
  /** Only with `assumed`: the probe's byte cap ended the reading before a key with "/" or every shard's end. */
  readonly exhausted?: true;
}

/** The step that lists one key's decisive range on its shard. */
interface OrderListStep {
  readonly kind: "list";
  readonly key: string;
  readonly range: OxiaRange;
}

export type ProbeStep =
  | { readonly kind: "verdict"; readonly verdict: OrderVerdict }
  | OrderListStep
  | { readonly kind: "sample" };

/** One shard's answers to the two probe gets. */
interface ProbeAnswer {
  readonly ceiling?: string;
  readonly floor?: string;
}

/** encoderHierarchical.Encode: the uint16 big-endian slash count, then the key with every "/" written 0xff. */
export function encodeHierarchical(key: string): Uint8Array {
  const bytes = utf8.encode(key);
  const out = new Uint8Array(bytes.length + 2);
  out.set(bytes, 2);
  let count = 0;
  for (const byte of bytes) if (byte === SLASH) count++;
  if (count !== 0) {
    for (let i = 2; i < out.length; i++) if (out[i] === SLASH) out[i] = ENCODED_SLASH;
    // A trailing "//" does not create a level (encode.go: sepCount--).
    if (bytes.length >= 2 && bytes[bytes.length - 1] === SLASH && bytes[bytes.length - 2] === SLASH) count--;
    if (key.startsWith(OXIA_INTERNAL_PREFIX)) count |= INTERNAL_LEVEL_BIT;
  }
  out[0] = (count >> 8) & 0xff;
  out[1] = count & 0xff;
  return out;
}

/** encoderNatural.Encode: the key's UTF-8 bytes, with an internal key's first two bytes written 0xff 0xff. */
export function encodeNatural(key: string): Uint8Array {
  const bytes = utf8.encode(key);
  if (key.startsWith(OXIA_INTERNAL_PREFIX)) {
    bytes[0] = ENCODED_SLASH;
    bytes[1] = ENCODED_SLASH;
  }
  return bytes;
}

/** Go's `bytes.Compare`: exactly -1, 0 or 1. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return Math.sign(a.length - b.length);
}

/** A comparator of key strings in a namespace's order. */
export function keyComparator(order: KeyOrder): (a: string, b: string) => number {
  const encode = order === "hierarchical" ? encodeHierarchical : encodeNatural;
  return (a, b) => compareBytes(encode(a), encode(b));
}

/** The level of a key under hierarchical sorting: the encoder's two leading bytes, the internal bit cleared. */
export function hierarchicalLevel(key: string): number {
  const encoded = encodeHierarchical(key);
  return ((encoded[0] << 8) | encoded[1]) & (INTERNAL_LEVEL_BIT - 1);
}

/**
 * The order probe's two gets per shard: the first key at or above "/" and the greatest key. Under hierarchical sorting
 * CEILING("/") is never a key without "/" (level 0 sorts first), so such an answer proves natural sorting.
 */
export const ORDER_PROBE_GETS: readonly OxiaGet[] = Object.freeze([
  Object.freeze({ key: "/", comparison: "CEILING", includeValue: false } as const),
  Object.freeze({ key: "/".repeat(PROBE_DEPTH), comparison: "FLOOR", includeValue: false } as const),
]);

/**
 * The decisive range of a key holding "/" (J4 5 step 3): with A the text before its first "/", [key, A + "0").
 * Natural sorting lists the key ("/" sorts below "0"); hierarchical sorting answers an empty range, the key being on
 * level 1 or deeper and A + "0" on level 0.
 */
function listStepRange(key: string): OxiaRange {
  return { startInclusive: key, endExclusive: `${key.slice(0, key.indexOf("/"))}0` };
}

/** The decision after the probe gets, one answer per shard in shard order. */
export function decideFromProbe(answers: readonly ProbeAnswer[]): ProbeStep {
  if (answers.some((answer) => answer.ceiling !== undefined && !answer.ceiling.includes("/"))) {
    return { kind: "verdict", verdict: { order: "natural", learnedBy: "ceiling-probe" } };
  }
  const key = answers
    .flatMap((answer) => [answer.ceiling, answer.floor])
    .find((answered) => answered !== undefined && answered.includes("/"));
  if (key !== undefined) return { kind: "list", key, range: listStepRange(key) };
  if (answers.every((answer) => answer.ceiling === undefined && answer.floor === undefined)) {
    return { kind: "verdict", verdict: { order: "hierarchical", learnedBy: "empty" } };
  }
  return { kind: "sample" };
}

/** The decision after the decisive List: the key came back only under natural sorting. */
export function decideFromList(key: string, listed: readonly string[]): OrderVerdict {
  return { order: listed.includes(key) ? "natural" : "hierarchical", learnedBy: "decisive-list" };
}

/** A pair increasing under exactly one encoder proves that order (the prototype's `judgePairs`). */
function judgePairs(keys: readonly string[]): KeyOrder | undefined {
  for (let i = 1; i < keys.length; i++) {
    const hierarchical = compareBytes(encodeHierarchical(keys[i - 1]), encodeHierarchical(keys[i])) < 0;
    const natural = compareBytes(encodeNatural(keys[i - 1]), encodeNatural(keys[i])) < 0;
    if (hierarchical !== natural) return hierarchical ? "hierarchical" : "natural";
  }
  return undefined;
}

/**
 * The decision over each shard's first keys: a telling pair, else the decisive List of the first sampled key holding
 * "/". `{ order: "hierarchical", learnedBy: "assumed" }` means the sample cannot decide: `walks.ts` reads on
 * (SB1-7.2 step 6) before it accepts that answer as the verdict.
 */
export function decideFromPairs(samples: readonly (readonly string[])[]): OrderVerdict | OrderListStep {
  for (const sample of samples) {
    const order = judgePairs(sample);
    if (order !== undefined) return { order, learnedBy: "pair-sample" };
  }
  const key = samples.flat().find((sampled) => sampled.includes("/"));
  if (key !== undefined) return { kind: "list", key, range: listStepRange(key) };
  return { order: "hierarchical", learnedBy: "assumed" };
}

/** Whether a verdict is re-probed on the next walk (SB1-7.2: `empty` and `assumed`). */
export function verdictIsProvisional(verdict: OrderVerdict): boolean {
  return verdict.learnedBy === "assumed" || verdict.learnedBy === "empty";
}

/** SB1-7.7: the greatest hierarchicalLevel among the FLOOR answers; 0 when none. */
export function maxLevel(floorKeys: readonly (string | undefined)[]): number {
  let level = 0;
  for (const key of floorKeys) if (key !== undefined) level = Math.max(level, hierarchicalLevel(key));
  return level;
}

/**
 * Direct children of the node named `p` under hierarchical sorting: keys `p + "/" + s`, s holding no "/". The idiom
 * [p/, p//) is exact when p does not end in "/". When it does, `p + "/"` ends in "//", which the encoder puts one level
 * higher, so the lower bound becomes `p + "/\u0000"` and the key `p + "/"` is read with a get.
 */
export function childrenRange(p: string): {
  readonly start: string;
  readonly end: string;
  readonly extraGets: readonly string[];
} {
  if (p.endsWith("/")) return { start: `${p}/\u0000`, end: `${p}//`, extraGets: [`${p}/`] };
  return { start: `${p}/`, end: `${p}//`, extraGets: [] };
}

/** Direct children of `p` under natural sorting: the byte range of `p + "/"`, keeping the keys with no further "/". */
export function naturalChildrenRange(p: string): {
  readonly start: string;
  readonly end: string;
  readonly keep: (key: string) => boolean;
} {
  return { start: `${p}/`, end: `${p}0`, keep: (key) => key.indexOf("/", p.length + 1) === -1 };
}

/**
 * The root level under hierarchical sorting: every key with no "/" is on level 0, below "\u0000/", the least key of
 * level 1 (SB1-13 D6 supersedes the prototype's ["", "/")). The walk keeps the keys `isRootFlat` accepts.
 */
export const ROOT_FLAT_RANGE: { readonly start: ""; readonly end: "\u0000/" } = Object.freeze({
  start: "",
  end: "\u0000/",
} as const);

/** Whether a key is on the root level: it holds no "/". */
export function isRootFlat(key: string): boolean {
  return !key.includes("/");
}

export interface PrefixBand {
  readonly level: number;
  readonly start: string;
  readonly end: string;
  readonly extraGets: readonly string[];
}

function slashCount(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "/") count++;
  return count;
}

/** Band 0 of a prefix walk: x and every x + s, s with no "/", all on x's own level. */
function band0(x: string): { readonly start: string; readonly end: string; readonly extraGets: readonly string[] } {
  if (x.endsWith("/")) {
    // x = p + "/": band 0 is the children of p, and x + "/" (a trailing "//", on x's level) is read with a get. An x
    // ending in "//" is itself one level up, so it is read with a get too.
    if (x.endsWith("//")) return { start: `${x}\u0000`, end: `${x}/`, extraGets: [x, `${x}/`] };
    return { start: x, end: `${x}/`, extraGets: [`${x}/`] };
  }
  // The upper bound is x with its last code point raised by one, stepping over "/" (which would change the level):
  // every key of x's level that begins with x is below it, and no other.
  const points = [...x];
  for (let i = points.length - 1; i >= 0; i--) {
    // The tail after x's last "/" is all U+10FFFF: no raise keeps the level, so the bound is the head and one more "/"
    // (a trailing "//", which stays on x's level, above every byte 0x00 to 0xf4).
    if (points[i] === "/") return { start: x, end: `${points.slice(0, i + 1).join("")}/`, extraGets: [] };
    let point = (points[i].codePointAt(0) as number) + 1;
    if (point === 0x2f) point = 0x30;
    if (point === 0xd800) point = 0xe000;
    if (point <= 0x10ffff) {
      return { start: x, end: points.slice(0, i).join("") + String.fromCodePoint(point), extraGets: [] };
    }
    // U+10FFFF: carry into the previous code point (the band then also holds x's longer siblings).
  }
  return { start: x, end: "/", extraGets: [] };
}

/**
 * A prefix walk under hierarchical sorting: every key that begins with the literal prefix x, as one band per level from
 * x's own to `maxLevel`, band by band in the encoder's order. Band m >= 1 is [lowerAtLevel(x, c + m), x + "/" * (m + 1))
 * plus the key x + "/" * (m + 1) itself, read with a get. A band's lower bound cannot be exact, so the walk keeps only
 * the keys that begin with x.
 *
 * Every key a band yields lies on `band.level` (its extra gets aside), so a walk keeps only the keys of the band's
 * level that begin with x; for a prefix that is all U+0000 the deeper bands start unbounded and also span shallower
 * levels.
 */
export function prefixBands(x: string, maxLevel: number): readonly PrefixBand[] {
  const level = slashCount(x);
  const bands: PrefixBand[] = [{ level, ...band0(x) }];
  for (let m = 1; level + m <= maxLevel; m++) {
    const end = x + "/".repeat(m + 1);
    bands.push({ level: level + m, start: lowerAtLevel(x, level + m), end, extraGets: [end] });
  }
  return bands;
}

/**
 * A lower bound on level L below every key of that level that begins with x: x without its trailing U+0000s, its last
 * code point lowered by one (over the surrogates, and over "/", which encodes as 0xff), then "/" appended until the
 * level is L. When x is all U+0000 there is no predecessor, and the band starts unbounded ("").
 */
export function lowerAtLevel(x: string, level: number): string {
  const points = [...x];
  while (points.length > 0 && points[points.length - 1] === "\u0000") points.pop();
  if (points.length === 0) return "";
  let point = (points[points.length - 1].codePointAt(0) as number) - 1;
  if (point >= 0xd800 && point <= 0xdfff) point = 0xd7ff;
  if (point === 0x2f) point = 0x2e;
  let bound = points.slice(0, -1).join("") + String.fromCodePoint(point);
  while (hierarchicalLevel(bound) < level) bound += "/";
  return bound;
}

/**
 * Natural sorting: every key that begins with x is the byte range [x, naturalPrefixEnd(x)), the end being x with its
 * last code point raised by one (UTF-8 byte order is code point order), carrying over U+10FFFF and stepping over the
 * surrogates; "" (unbounded) when x is all U+10FFFF.
 */
export function naturalPrefixEnd(x: string): string {
  const points = [...x];
  for (let i = points.length - 1; i >= 0; i--) {
    let point = (points[i].codePointAt(0) as number) + 1;
    if (point === 0xd800) point = 0xe000;
    if (point <= 0x10ffff) return points.slice(0, i).join("") + String.fromCodePoint(point);
  }
  return "";
}

/** The top-level node a key belongs to: its text up to the "/" that ends its first segment, or none. */
export function topNode(key: string): string | undefined {
  const i = key.indexOf("/", key.startsWith("/") ? 1 : 0);
  return i < 0 ? undefined : key.slice(0, i);
}

export interface DiscoveryProbe {
  readonly key: string;
  readonly comparison: "CEILING" | "HIGHER" | "LOWER";
}

/**
 * The get that finds the next top-level node after the one `key` belongs to (SB1-8.2). `LOWER` is in the union for the
 * backward chain, which `walks.ts` sends itself.
 */
export function nextDiscoveryProbe(key: string, order: KeyOrder): DiscoveryProbe {
  const top = topNode(key);
  if (order === "hierarchical") {
    const level = hierarchicalLevel(key);
    if (top === undefined) return { key: "/".repeat(level + 1), comparison: "HIGHER" };
    return { key: top + "/".repeat(level - slashCount(top) + 1), comparison: "HIGHER" };
  }
  if (top === undefined) return { key, comparison: "HIGHER" };
  return { key: `${top}0`, comparison: "CEILING" };
}

/** Whether text holds a lone UTF-16 surrogate (SB1-4.9); shared by the adapter, key-scan.ts and cursor.ts. */
export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}
