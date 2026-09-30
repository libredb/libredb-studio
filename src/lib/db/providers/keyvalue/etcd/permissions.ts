/**
 * What an etcd user who is not root may read and write (spec 4.7).
 *
 * Pure. etcd grants by byte ranges and has no call that says which ranges a caller may read (R06
 * section 8, item 8), so at connect the provider reads the user's roles with UserGet and each role's
 * permissions with RoleGet, and this module merges them the way etcd's own check merges them (SRC
 * etcd__server_auth_range_perm_cache.go, getMergedPerms and the interval tree's Contains): READ and
 * READWRITE into what may be read, WRITE and READWRITE into what may be written, each a union of
 * disjoint byte ranges in which grants that overlap or touch are one, so a group or a key is never
 * counted twice. A union that holds every key is `{ kind: "all" }`.
 */
import type { EtcdByteRange, EtcdBytes, EtcdPermission, EtcdPermissionType } from "./client";
import { compareBytes, type KeySpan, keySpan, prefixRangeEnd, spanIsEmpty, spanToRange, typedKey } from "./keys";

export type AccessScope =
  | { readonly kind: "all" }
  | { readonly kind: "ranges"; readonly ranges: readonly EtcdByteRange[] };

const READ_TYPES: ReadonlySet<EtcdPermissionType> = new Set(["read", "readwrite"]);
const WRITE_TYPES: ReadonlySet<EtcdPermissionType> = new Set(["write", "readwrite"]);

/**
 * A permission as the interval etcd inserts for it. etcd stores no grant with an empty key or with a
 * range end at or before its key (isValidPermissionRange, and RoleGrantPermission refuses one), so
 * either is a decoding fault and is raised, never read as a grant of nothing.
 */
function permissionSpan(permission: EtcdPermission): KeySpan {
  if (permission.key.length === 0) {
    throw new TypeError("A permission with an empty key is not one etcd grants (isValidPermissionRange)");
  }
  const span = keySpan(permission);
  if (spanIsEmpty(span)) {
    throw new TypeError(
      "A permission whose range end is at or before its key is not one etcd grants (isValidPermissionRange)",
    );
  }
  return span;
}

/** Sorted by where they begin, with every two that overlap or touch made one. */
function mergeSpans(spans: readonly KeySpan[]): KeySpan[] {
  const merged: KeySpan[] = [];
  for (const span of [...spans].sort((a, b) => compareBytes(a.begin, b.begin))) {
    const last = merged[merged.length - 1];
    if (last === undefined || (last.end !== undefined && compareBytes(span.begin, last.end) > 0)) {
      merged.push(span);
    } else if (last.end !== undefined && (span.end === undefined || compareBytes(span.end, last.end) > 0)) {
      merged[merged.length - 1] = span.end === undefined ? { begin: last.begin } : { begin: last.begin, end: span.end };
    }
  }
  return merged;
}

/** An interval that holds every key: open-ended from at or before 0x00, the smallest key etcd holds. */
function holdsEveryKey(span: KeySpan): boolean {
  return span.end === undefined && compareBytes(span.begin, Uint8Array.of(0)) <= 0;
}

function scopeOf(permissions: readonly EtcdPermission[], types: ReadonlySet<EtcdPermissionType>): AccessScope {
  const merged = mergeSpans(permissions.filter((permission) => types.has(permission.type)).map(permissionSpan));
  if (merged.length === 1 && holdsEveryKey(merged[0])) return { kind: "all" };
  return { kind: "ranges", ranges: merged.map(spanToRange) };
}

/** READ and READWRITE, merged and sorted (spec 4.7). */
export function readableScope(permissions: readonly EtcdPermission[]): AccessScope {
  return scopeOf(permissions, READ_TYPES);
}

/** WRITE and READWRITE, merged and sorted (spec 4.7, the edit offer). */
export function writableScope(permissions: readonly EtcdPermission[]): AccessScope {
  return scopeOf(permissions, WRITE_TYPES);
}

/** A scope's ranges as merged intervals, whether or not its caller merged them. */
function scopeSpans(scope: { readonly ranges: readonly EtcdByteRange[] }): KeySpan[] {
  return mergeSpans(scope.ranges.map(keySpan));
}

/** Whether the scope holds every key of the range; a range that holds no key is covered by any scope. */
export function rangeCovered(range: EtcdByteRange, scope: AccessScope): boolean {
  const span = keySpan(range);
  if (scope.kind === "all" || spanIsEmpty(span)) return true;
  return scopeSpans(scope).some(
    (piece) =>
      compareBytes(piece.begin, span.begin) <= 0 &&
      (piece.end === undefined || (span.end !== undefined && compareBytes(piece.end, span.end) >= 0)),
  );
}

/** The pieces of the range the scope holds, in byte order, each in its plainest spelling (spec 4.7). */
export function clipToScope(range: EtcdByteRange, scope: AccessScope): readonly EtcdByteRange[] {
  const span = keySpan(range);
  if (spanIsEmpty(span)) return [];
  if (scope.kind === "all") return [spanToRange(span)];
  const pieces: EtcdByteRange[] = [];
  for (const piece of scopeSpans(scope)) {
    const begin = compareBytes(piece.begin, span.begin) > 0 ? piece.begin : span.begin;
    const end =
      piece.end === undefined
        ? span.end
        : span.end === undefined || compareBytes(piece.end, span.end) < 0
          ? piece.end
          : span.end;
    const clipped: KeySpan = end === undefined ? { begin } : { begin, end };
    if (!spanIsEmpty(clipped)) pieces.push(spanToRange(clipped));
  }
  return pieces;
}

/** The one key, as etcd's point interval ends it: the key and one 0x00 byte. */
function endsAfterOneKey(key: EtcdBytes, end: EtcdBytes): boolean {
  return end.length === key.length + 1 && end[key.length] === 0 && compareBytes(end.subarray(0, key.length), key) === 0;
}

/**
 * A byte range as one piece of spec 4.7: a single key, a prefix, or a start and end key. The whole
 * key space is the empty prefix, as etcdctl writes it (`get '' --prefix`); a range that runs to the
 * end of the key space and is no prefix is a start and the end 0x00, etcd's own open end.
 */
export function rangeShape(
  range: EtcdByteRange,
):
  | { readonly shape: "key"; readonly key: EtcdBytes }
  | { readonly shape: "prefix"; readonly prefix: EtcdBytes }
  | { readonly shape: "range"; readonly start: EtcdBytes; readonly end: EtcdBytes } {
  const end = range.rangeEnd;
  if (end === undefined || end.length === 0 || endsAfterOneKey(range.key, end)) return { shape: "key", key: range.key };
  if (holdsEveryKey(keySpan(range))) return { shape: "prefix", prefix: new Uint8Array() };
  if (compareBytes(end, prefixRangeEnd(range.key)) === 0) return { shape: "prefix", prefix: range.key };
  return { shape: "range", start: range.key, end };
}

/**
 * A range as spec 5.6's "may read" list writes it: "/app/ (prefix)", "/cfg/x", "/a (from key)" or "/a
 * to /b (range)".
 */
export function describeRange(range: EtcdByteRange): string {
  const shape = rangeShape(range);
  if (shape.shape === "key") return typedKey(shape.key, "command-line");
  if (shape.shape === "prefix") {
    return shape.prefix.length === 0 ? "every key" : `${typedKey(shape.prefix, "command-line")} (prefix)`;
  }
  const start = typedKey(shape.start, "command-line");
  // The open end as keySpan reads it, so this file holds no second copy of etcd's rule.
  if (keySpan(range).end === undefined) return `${start} (from key)`;
  return `${start} to ${typedKey(shape.end, "command-line")} (range)`;
}

/** A scope as 5.6's sentence names it: "every key", "no key", or its ranges in byte order. */
export function describeScope(scope: AccessScope): string {
  if (scope.kind === "all") return "every key";
  return scope.ranges.length === 0 ? "no key" : scope.ranges.map(describeRange).join(", ");
}
