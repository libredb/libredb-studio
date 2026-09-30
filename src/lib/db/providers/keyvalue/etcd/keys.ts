/**
 * Keys and byte ranges as etcd reads them (spec 3.1, 4.1, 4.3, 5.5, E8, E9).
 *
 * Pure, and shipped to the browser: the confirmation gate (guard.ts), the generators and the
 * provider read one rule for a range, a protected key and a prefix group. It imports the lexer's
 * quoting functions and, as types only, the seam.
 *
 * A range is bytes, read with etcd's own conventions (R06 2.3; SRC
 * etcd__server_auth_range_perm_cache.go, rules b1 to b3): no range end, or an empty one, is the one
 * key; a range end of the single byte 0x00 runs to the end of the key space; the key 0x00 with that
 * range end is every key; and any other range holds the keys from its key up to, and not including,
 * its range end.
 */
import type { EtcdByteRange, EtcdBytes, EtcdInt64 } from "./client";
import { quoteGoString, quoteTxnWord, quoteWord } from "./lexer";

// ============================================================================
// Bytes and text
// ============================================================================

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF: without it the decoder drops it and the text is not the bytes.
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** etcd's key order, Go's bytes.Compare: a negative number, 0, or a positive number. */
export function compareBytes(a: EtcdBytes, b: EtcdBytes): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

/** Whether `bytes` begins with every byte of `prefix`. */
export function hasBytePrefix(bytes: EtcdBytes, prefix: EtcdBytes): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

/**
 * A key's text as its UTF-8 bytes, as TextEncoder writes them: a lone UTF-16 surrogate becomes
 * U+FFFD, so a caller holding text from outside the provider, such as a path in a request, holds it
 * to `decodeUtf8(encodeKey(text)) === text` before it reads the bytes as that key (spec 4.6).
 */
export function encodeKey(text: string): EtcdBytes {
  return encoder.encode(text);
}

/** The bytes as text, strictly: undefined when they are not UTF-8, never replacement characters. */
export function decodeUtf8(bytes: EtcdBytes): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** Unicode's control characters, C0, DEL and C1, which a one-line field cannot show (spec 5.5). */
function holdsControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || (unit >= 0x7f && unit <= 0x9f)) return true;
  }
  return false;
}

/** The word rule a key is written under: the command line's shell rule, or a txn body's (spec 5.1.1, 5.1.4). */
export type KeyQuoting = "command-line" | "txn";

/**
 * A key as a person reads and types it back (spec 5.5): in the quoting of the rule it was written
 * under, bare when a bare word reads back as the same bytes, and in Go `%q` under either rule when
 * it holds a control character or is not UTF-8, because the typed field is one line and the command
 * line has no escape for a byte that is not text.
 */
export function typedKey(key: EtcdBytes, quoting: KeyQuoting): string {
  const text = decodeUtf8(key);
  if (text === undefined || holdsControlCharacter(text)) return quoteGoString(key);
  return quoting === "command-line" ? quoteWord(text) : quoteTxnWord(key);
}

// ============================================================================
// Ranges (spec E8, R06 2.3)
// ============================================================================

/** The range end etcd reads as "to the end of the key space". */
const OPEN_END = 0x00;

function isOpenEnd(rangeEnd: EtcdBytes): boolean {
  return rangeEnd.length === 1 && rangeEnd[0] === OPEN_END;
}

/**
 * key 0x00, rangeEnd 0x00: the whole key space, as etcdctl sends an empty key with --prefix or
 * --from-key. The object is frozen; its two arrays are shared, so read them and never write them.
 */
export const ALL_KEYS: EtcdByteRange = Object.freeze({
  key: Uint8Array.of(OPEN_END),
  rangeEnd: Uint8Array.of(OPEN_END),
});

/**
 * etcd's prefix rule (R06 2.3; clientv3 GetPrefixRangeEnd): the prefix with its last byte below
 * 0xff raised by one and every byte after it dropped, or 0x00, "to the end", when every byte is
 * 0xff; an empty prefix gives 0x00.
 */
export function prefixRangeEnd(prefix: EtcdBytes): EtcdBytes {
  for (let index = prefix.length - 1; index >= 0; index--) {
    if (prefix[index] < 0xff) {
      const end = prefix.slice(0, index + 1);
      end[index] += 1;
      return end;
    }
  }
  return Uint8Array.of(OPEN_END);
}

/** The byte range a parsed get, del or watch names: the key alone, a range end, --prefix or --from-key. */
export function commandRange(spec: {
  readonly key: EtcdBytes;
  readonly rangeEnd?: EtcdBytes;
  readonly prefix: boolean;
  readonly fromKey: boolean;
}): EtcdByteRange {
  if ((spec.prefix || spec.fromKey) && spec.key.length === 0) {
    return { key: Uint8Array.of(OPEN_END), rangeEnd: Uint8Array.of(OPEN_END) };
  }
  if (spec.prefix) return { key: spec.key, rangeEnd: prefixRangeEnd(spec.key) };
  if (spec.fromKey) return { key: spec.key, rangeEnd: Uint8Array.of(OPEN_END) };
  return spec.rangeEnd === undefined ? { key: spec.key } : { key: spec.key, rangeEnd: spec.rangeEnd };
}

/**
 * A range as the half-open interval etcd checks: from `begin` up to `end`, or to the end of the key
 * space when `end` is absent.
 */
export interface KeySpan {
  readonly begin: EtcdBytes;
  readonly end?: EtcdBytes;
}

/** The key and one 0x00 byte after it: the one key as an interval, etcd's NewBytesAffinePoint. */
function successor(key: EtcdBytes): EtcdBytes {
  const next = new Uint8Array(key.length + 1);
  next.set(key);
  return next;
}

/** A range as its interval, by the conventions this file's docblock states. */
export function keySpan(range: EtcdByteRange): KeySpan {
  const end = range.rangeEnd;
  if (end === undefined || end.length === 0) return { begin: range.key, end: successor(range.key) };
  return isOpenEnd(end) ? { begin: range.key } : { begin: range.key, end };
}

/** The range an interval is, in its plainest spelling: one key with no range end, an open end as 0x00. */
export function spanToRange(span: KeySpan): EtcdByteRange {
  if (span.end === undefined) return { key: span.begin, rangeEnd: Uint8Array.of(OPEN_END) };
  if (compareBytes(span.end, successor(span.begin)) === 0) return { key: span.begin };
  return { key: span.begin, rangeEnd: span.end };
}

/** An interval that holds no key: its end at or before its begin. */
export function spanIsEmpty(span: KeySpan): boolean {
  return span.end !== undefined && compareBytes(span.end, span.begin) <= 0;
}

/** Whether `key` lies in the interval. */
function spanHolds(span: KeySpan, key: EtcdBytes): boolean {
  return compareBytes(span.begin, key) <= 0 && (span.end === undefined || compareBytes(key, span.end) < 0);
}

/** Whether the two ranges hold a key in common, on bytes, with etcd's conventions (spec E8). */
export function rangesIntersect(a: EtcdByteRange, b: EtcdByteRange): boolean {
  const x = keySpan(a);
  const y = keySpan(b);
  if (spanIsEmpty(x) || spanIsEmpty(y)) return false;
  const xEndsFirst = x.end !== undefined && compareBytes(x.end, y.begin) <= 0;
  const yEndsFirst = y.end !== undefined && compareBytes(y.end, x.begin) <= 0;
  return !xEndsFirst && !yEndsFirst;
}

// ============================================================================
// The protected set (spec E8) and the secrets roots (spec E9)
// ============================================================================

/**
 * The storage roots of the Kubernetes distributions R09 measured, each with and without its leading
 * "/" (spec E8): kube-apiserver's default --etcd-prefix `/registry/`; OpenShift's `/kubernetes.io/`
 * and `/openshift.io/`; k3s's `/bootstrap/`, which holds the cluster's CA keys, and `k3s/`, the
 * root k3s names after its program name (SRC landscape/k3s-v1.37.0+k3s1__pkg_etcd_etcd.go,
 * learnerProgressKey and AddressKey, both `version.Program + "/..."`); and `rke2/`, inferred and
 * not measured: rancher/rke2 v1.37.0+rke2r1 (commit 37af8f9f73a0e95c36295142a63fdcb218cd34e2)
 * builds that same k3s code with scripts/version.sh's `PROG=rke2` passed by scripts/build-binary
 * as `-X ${K3S_PKG}/pkg/version.Program=${PROG}`, so its roots are `rke2/...`.
 */
export const PROTECTED_PREFIXES: readonly string[] = Object.freeze([
  "/registry/",
  "registry/",
  "/kubernetes.io/",
  "kubernetes.io/",
  "/openshift.io/",
  "openshift.io/",
  "/bootstrap/",
  "bootstrap/",
  "/k3s/",
  "k3s/",
  "/rke2/",
  "rke2/",
]);

/**
 * The one exact key of spec E8: kube-apiserver's compaction clock, at the root of the key space and
 * outside every --etcd-prefix (SRC
 * review-lens-etcd/k8s-v1.37.1__staging_src_k8s.io_apiserver_pkg_storage_etcd3_compact.go,
 * compactRevKey).
 */
export const PROTECTED_KEYS: readonly string[] = Object.freeze(["compact_rev_key"]);

/** Spec E9 row 1's secrets roots, each with and without its leading "/". */
export const SECRET_ROOTS: readonly string[] = Object.freeze([
  "/registry/secrets/",
  "registry/secrets/",
  "/kubernetes.io/secrets/",
  "kubernetes.io/secrets/",
  "/bootstrap/",
  "bootstrap/",
]);

const PROTECTED_PREFIX_RANGES = PROTECTED_PREFIXES.map((name) => {
  const key = encodeKey(name);
  return { name, range: { key, rangeEnd: prefixRangeEnd(key) } };
});
const PROTECTED_KEY_RANGES = PROTECTED_KEYS.map((name) => ({ name, range: { key: encodeKey(name) } }));
const PROTECTED_PREFIX_BYTES = PROTECTED_PREFIXES.map(encodeKey);
const SECRET_ROOT_BYTES = SECRET_ROOTS.map(encodeKey);

/**
 * The protected prefix or key a range meets, or undefined (spec E8): the prefixes in their listed
 * order first, then the key, which is intersected as the point [compact_rev_key, compact_rev_key\0).
 */
export function protectedHit(
  range: EtcdByteRange,
): { readonly kind: "prefix" | "key"; readonly name: string } | undefined {
  for (const entry of PROTECTED_PREFIX_RANGES) {
    if (rangesIntersect(range, entry.range)) return { kind: "prefix", name: entry.name };
  }
  for (const entry of PROTECTED_KEY_RANGES) {
    if (rangesIntersect(range, entry.range)) return { kind: "key", name: entry.name };
  }
  return undefined;
}

/** E9 row 1: a key under a secrets root, withheld whatever its bytes. */
export function isSecretKey(key: EtcdBytes): boolean {
  return SECRET_ROOT_BYTES.some((root) => hasBytePrefix(key, root));
}

/** E9 rows 4 and 5: a key under a protected prefix, whose CBOR and JSON values carry a Kubernetes label. */
export function isUnderProtectedPrefix(key: EtcdBytes): boolean {
  return PROTECTED_PREFIX_BYTES.some((prefix) => hasBytePrefix(key, prefix));
}

// ============================================================================
// Prefix groups (spec 4.1) and the walk's pure step (spec 4.3)
// ============================================================================

/** A disjoint prefix group (spec 4.1): `prefix` is text ending in "/", `range` its prefix range. */
export interface PrefixGroup {
  readonly prefix: string;
  readonly range: EtcdByteRange;
  /**
   * A first segment whose keys reached the per-segment budget P before its shape was decided (spec
   * 4.3, R13 D9): `F/*` over the prefix range of `F/`, its deeper groups not listed.
   */
  readonly undecided?: true;
}

const SLASH = 0x2f;

/** Where a key's first two segments end (spec 4.1 rule 2): `F/` from two segments on, `F/S/` from three. */
interface KeyPlace {
  /** The key's bytes up to and including the "/" after its first segment. */
  readonly first?: EtcdBytes;
  /** Up to and including the "/" after its second segment. */
  readonly second?: EtcdBytes;
}

/**
 * A leading "/" is the root and is kept, and a key with none has a root of its own; after the root
 * the key splits on "/", a byte no UTF-8 sequence holds inside a character, so the split on bytes
 * is the split on text.
 */
function placeKey(key: EtcdBytes): KeyPlace {
  const firstSlash = key.indexOf(SLASH, key[0] === SLASH ? 1 : 0);
  if (firstSlash < 0) return {};
  const first = key.subarray(0, firstSlash + 1);
  const secondSlash = key.indexOf(SLASH, firstSlash + 1);
  return secondSlash < 0 ? { first } : { first, second: key.subarray(0, secondSlash + 1) };
}

/** The prefix range of a group's prefix. Its bytes end in "/", so the range end is never the open 0x00. */
function prefixRangeOf(prefix: EtcdBytes): EtcdByteRange {
  const key = prefix.slice();
  return { key, rangeEnd: prefixRangeEnd(key) };
}

/** The group over a UTF-8 prefix ending in "/". */
function groupOf(prefix: EtcdBytes, undecided: boolean): PrefixGroup {
  const group = { prefix: decodeUtf8(prefix) as string, range: prefixRangeOf(prefix) };
  return undecided ? { ...group, undecided: true } : group;
}

/** A string that stands for a byte sequence, one character per byte, for a Map key. */
function byteId(bytes: EtcdBytes): string {
  let id = "";
  for (const byte of bytes) id += String.fromCharCode(byte);
  return id;
}

/**
 * Spec 4.1's rule over a set of keys (R13 A1, D8), which the walk of 4.3 is tested against: the
 * result depends only on the set, the groups in byte order and the keys in no group in byte order.
 *
 * For each first segment F, when every key under `F/` has two segments, `F/*` is one group; else
 * each key of three or more segments belongs to `F/S/*`, and F's two-segment keys to no group. A
 * one-segment key, a key whose first segment is not UTF-8, and under a deep F a key whose second
 * segment is not UTF-8 belong to no group, the last still making F deep (rule 7).
 */
export function prefixGroups(keys: Iterable<EtcdBytes>): {
  readonly groups: readonly PrefixGroup[];
  readonly ungrouped: readonly EtcdBytes[];
} {
  const unique = new Map<string, EtcdBytes>();
  for (const key of keys) unique.set(byteId(key), key);
  const firsts = new Map<
    string,
    { first: EtcdBytes; deep: boolean; flat: EtcdBytes[]; deeper: Map<string, EtcdBytes> }
  >();
  const ungrouped: EtcdBytes[] = [];
  for (const key of unique.values()) {
    const place = placeKey(key);
    if (place.first === undefined || decodeUtf8(place.first) === undefined) {
      ungrouped.push(key);
      continue;
    }
    const firstId = byteId(place.first);
    let entry = firsts.get(firstId);
    if (entry === undefined) {
      entry = { first: place.first, deep: false, flat: [], deeper: new Map() };
      firsts.set(firstId, entry);
    }
    if (place.second === undefined) {
      entry.flat.push(key);
      continue;
    }
    entry.deep = true;
    if (decodeUtf8(place.second) === undefined) ungrouped.push(key);
    else entry.deeper.set(byteId(place.second), place.second);
  }
  const groups: PrefixGroup[] = [];
  for (const entry of firsts.values()) {
    if (!entry.deep) {
      groups.push(groupOf(entry.first, false));
      continue;
    }
    ungrouped.push(...entry.flat);
    for (const second of entry.deeper.values()) groups.push(groupOf(second, false));
  }
  groups.sort((a, b) => compareBytes(a.range.key, b.range.key));
  ungrouped.sort(compareBytes);
  return { groups, ungrouped };
}

/** Always `${group.prefix}*`: no row is named after a key (spec 4.1 rule 5). */
export function groupLabel(group: PrefixGroup): string {
  return `${group.prefix}*`;
}

/** The first segment the walk is reading: its shape not yet decided, or decided deep (spec 4.3). */
export interface PrefixWalkSegment {
  /** The prefix range of `F/`. */
  readonly range: EtcdByteRange;
  /** A key of three or more segments was read under it, so its groups are `F/S/*`. */
  readonly deep: boolean;
  /** The keys read under `F/`, the count the per-segment budget P is held to. */
  readonly keysRead: number;
}

/** The walk's record so far (spec 4.3). */
export interface PrefixWalkState {
  /** The groups decided so far, in byte order. */
  readonly groups: readonly PrefixGroup[];
  /** Every key the pages held, those skipped inside a group included: the count the bound S is held to. */
  readonly keysRead: number;
  /** The first segment being read, absent between two. */
  readonly segment?: PrefixWalkSegment;
  /**
   * A range whose every key the rule puts in no group (a first or second segment that is not UTF-8),
   * skipped as a group is.
   */
  readonly skip?: EtcdByteRange;
  /** The last key read: the next page begins after it. */
  readonly lastKey?: EtcdBytes;
}

export const INITIAL_PREFIX_WALK: PrefixWalkState = Object.freeze({ groups: Object.freeze([]), keysRead: 0 });

/**
 * The walk's pure step (spec 4.3): the record so far plus one keys_only page read in byte order,
 * and where the next page starts, past a recorded group's range end when the page ended inside
 * one; undefined when the pages given so far are exhausted (`more: false`). The driver moves from
 * one readable range to the next (spec 4.7) and starts each past a recorded group that holds it.
 *
 * A key inside a recorded group or a skipped range is counted and passed over. A key of three or
 * more segments records `F/S/*` and makes F deep. A two-segment key is counted under F until F is
 * known to be deep or flat: F is flat, `F/*`, once the walk passes F with no deeper key read, and a
 * first segment whose keys alone reach the budget P while its shape is undecided is recorded as
 * `F/*` marked undecided (R13 D9), so the next page starts past it. A range whose keys the rule puts
 * in no group, under a first segment that is not UTF-8 or, under a deep F, a second segment that is
 * not UTF-8 (rule 7), is passed over the same way, since reading it could list no group.
 */
export function stepPrefixWalk(
  state: PrefixWalkState,
  page: { readonly keys: readonly EtcdBytes[]; readonly more: boolean },
  bounds: { readonly segmentBudget: number },
): { readonly state: PrefixWalkState; readonly next: EtcdBytes | undefined } {
  const budget = bounds.segmentBudget;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new RangeError("The walk's per-segment budget is a whole number of keys, 1 or more");
  }
  if (page.more && page.keys.length === 0) {
    throw new RangeError("A keys_only page that says more keys follow holds at least one key");
  }
  const groups = [...state.groups];
  let { segment, skip, lastKey } = state;
  let keysRead = state.keysRead;
  for (const key of page.keys) {
    if (lastKey !== undefined && compareBytes(key, lastKey) <= 0) {
      throw new RangeError("The walk reads keys in byte order, each after the last key it read");
    }
    lastKey = key;
    keysRead += 1;
    const recorded = groups[groups.length - 1];
    if (recorded !== undefined && spanHolds(keySpan(recorded.range), key)) continue;
    if (skip !== undefined && spanHolds(keySpan(skip), key)) continue;
    if (segment !== undefined && !spanHolds(keySpan(segment.range), key)) {
      if (!segment.deep) groups.push(groupOf(segment.range.key, false));
      segment = undefined;
    }
    const place = placeKey(key);
    if (place.first === undefined) continue;
    if (decodeUtf8(place.first) === undefined) {
      skip = prefixRangeOf(place.first);
      continue;
    }
    const current: PrefixWalkSegment = segment ?? { range: prefixRangeOf(place.first), deep: false, keysRead: 0 };
    if (place.second !== undefined) {
      segment = { range: current.range, deep: true, keysRead: current.keysRead + 1 };
      if (decodeUtf8(place.second) === undefined) skip = prefixRangeOf(place.second);
      else groups.push(groupOf(place.second, false));
      continue;
    }
    segment = { range: current.range, deep: current.deep, keysRead: current.keysRead + 1 };
    if (!segment.deep && segment.keysRead >= budget) {
      groups.push(groupOf(place.first, true));
      segment = undefined;
    }
  }
  const next: PrefixWalkState = {
    groups,
    keysRead,
    ...(segment === undefined ? {} : { segment }),
    ...(skip === undefined ? {} : { skip }),
    ...(lastKey === undefined ? {} : { lastKey }),
  };
  if (!page.more) return { state: next, next: undefined };
  const last = lastKey as EtcdBytes;
  const recorded = groups[groups.length - 1];
  const jump = [recorded?.range, skip].find((range) => range !== undefined && spanHolds(keySpan(range), last));
  return { state: next, next: jump === undefined ? successor(last) : (jump.rangeEnd as EtcdBytes) };
}

/**
 * The groups decided so far, undecided `F/*` groups included (R13 D9). A finished walk also decides
 * the first segment it was reading, `F/*` when it is flat; an unfinished one, stopped by G or S,
 * does not report a first segment it has not finished (spec 4.3).
 */
export function prefixWalkResult(state: PrefixWalkState, finished: boolean): readonly PrefixGroup[] {
  const segment = state.segment;
  if (!finished || segment === undefined || segment.deep) return state.groups;
  return [...state.groups, groupOf(segment.range.key, false)];
}

// ============================================================================
// Member and lease ids (spec 4.1)
// ============================================================================

/** A uint64 in decimal as the adapter hands one over: no sign and no leading zero. */
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
/** An int64 in decimal as the adapter hands one over: a minus sign only before a value other than 0. */
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/;
const HEX = /^[0-9a-fA-F]+$/;
/**
 * A member id is a uint64 and a lease id an int64 (etcdserverpb); derived, never spelled. The lease
 * ids etcd picks are positive, but etcd grants an id a client chooses, a negative one included
 * (etcd v3.7.0: server/etcdserver/v3_server.go LeaseGrant picks an id only for 0, and
 * server/lease/lessor.go Grant refuses only 0), so a listing can hold one.
 */
const UINT64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const INT64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
const INT64_MIN = -(BigInt(1) << BigInt(63));

function decimalId(decimal: EtcdInt64, pattern: RegExp, max: bigint, what: string): bigint {
  if (!pattern.test(decimal)) throw new TypeError(`${what} is not a decimal integer as the adapter hands ids over`);
  const value = BigInt(decimal);
  if (value > max) throw new RangeError(`${what} is past the largest id etcd holds`);
  return value;
}

/**
 * A member id as `member list` prints it: `%x`, unpadded lowercase (SRC
 * review-lens-etcd/etcdctl__ctlv3__command__printer.go, makeMemberListTable).
 */
export function memberHexId(decimal: EtcdInt64): string {
  return decimalId(decimal, DECIMAL, UINT64_MAX, "A member id").toString(16);
}

/**
 * A lease id as `lease list` prints it: `%016x` (SRC
 * review-lens-etcd/etcdctl__ctlv3__command__printer_simple.go, Leases). A negative id is written as
 * Go writes it, the sign inside the width, so -5 is -000000000000005 (measured with go1.27.0, and
 * what etcdctl's lease list printed on v3.7.2, as commands.ts records).
 */
export function leaseHexId(decimal: EtcdInt64): string {
  const value = decimalId(decimal, SIGNED_DECIMAL, INT64_MAX, "A lease id");
  if (value < INT64_MIN) throw new RangeError("A lease id is past the smallest id etcd holds");
  if (value < BigInt(0)) return `-${(-value).toString(16).padStart(15, "0")}`;
  return value.toString(16).padStart(16, "0");
}

/** A hex id in any padding and case, as etcdctl's base-16 parse reads it; undefined when not hex or past 64 bits. */
export function fromHexId(hex: string): EtcdInt64 | undefined {
  if (!HEX.test(hex)) return undefined;
  const digits = hex.replace(/^0+/, "");
  if (digits.length > 16) return undefined;
  return BigInt(`0x${digits === "" ? "0" : digits}`).toString(10);
}
