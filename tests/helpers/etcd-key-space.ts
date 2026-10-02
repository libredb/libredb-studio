/**
 * A key space served the way etcd serves a `Range` (C1's types), for the fake clients of the etcd provider's
 * tests (#1089).
 *
 * Byte order; etcd's range conventions (no end is the key alone, an end of one 0x00 byte runs to the end);
 * `limit`, `keysOnly` and `countOnly`; and, when grants are given, etcd's refusal of a range its caller may not
 * read whole: etcd merges a user's permissions into disjoint intervals and refuses a request no one interval
 * covers (spec 4.7, R06 4.2), with the `PermissionDenied` answer the adapter hands up. It is the tests' oracle
 * for what etcd would answer, so it shares no range arithmetic with the provider's `keys.ts` or `permissions.ts`.
 */
import {
  type EtcdByteRange,
  type EtcdClient,
  EtcdError,
  type EtcdKeyValue,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
  type EtcdResponseHeader,
} from "@/lib/db/providers/keyvalue/etcd/client";

/** A key and its value, both text, as a test writes them. */
export interface KeySpaceEntry {
  readonly key: string;
  readonly value: string;
}

/** One member's header, as a single-member cluster answers every read. */
export const KEY_SPACE_HEADER: EtcdResponseHeader = {
  clusterId: "14841639068965178418",
  memberId: "10276657743932975437",
  revision: "34",
  raftTerm: "2",
};

/** etcd's refusal of a range the caller's grants do not cover (R06 4.2), as the adapter hands it up. */
export function permissionDenied(): EtcdError {
  return new EtcdError("permission-denied", "etcdserver: permission denied", 7);
}

const encoder = new TextEncoder();

const compare = (a: Uint8Array, b: Uint8Array): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const runsToEnd = (end: Uint8Array): boolean => end.length === 1 && end[0] === 0;

/** A range as an interval with an explicit end: a single key `k` is `[k, k + 0x00)`. */
function interval(range: EtcdByteRange): { readonly key: Uint8Array; readonly end: Uint8Array } {
  const end = range.rangeEnd;
  return { key: range.key, end: end === undefined || end.length === 0 ? Uint8Array.from([...range.key, 0]) : end };
}

/** Whether `key` lies in `range` by etcd's conventions. */
function inRange(key: Uint8Array, range: EtcdByteRange): boolean {
  const { key: start, end } = interval(range);
  return compare(key, start) >= 0 && (runsToEnd(end) || compare(key, end) < 0);
}

/** The grants merged into disjoint intervals, sorted, as etcd merges a user's permissions before it checks one. */
function merged(grants: readonly EtcdByteRange[]): Array<{ key: Uint8Array; end: Uint8Array }> {
  const sorted = grants.map(interval).sort((a, b) => compare(a.key, b.key));
  const out: Array<{ key: Uint8Array; end: Uint8Array }> = [];
  for (const next of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && (runsToEnd(last.end) || compare(next.key, last.end) <= 0)) {
      if (!runsToEnd(last.end) && (runsToEnd(next.end) || compare(next.end, last.end) > 0)) last.end = next.end;
    } else {
      out.push({ key: next.key, end: next.end });
    }
  }
  return out;
}

/** Whether one merged interval holds every key the request could name. */
function covered(request: EtcdByteRange, grants: ReadonlyArray<{ key: Uint8Array; end: Uint8Array }>): boolean {
  const asked = interval(request);
  return grants.some(
    (grant) =>
      compare(asked.key, grant.key) >= 0 &&
      (runsToEnd(grant.end) || (!runsToEnd(asked.end) && compare(asked.end, grant.end) <= 0)),
  );
}

/**
 * A `range` over `entries`, served in byte order at one revision. With `grants`, a request no merged grant
 * covers is refused, as etcd refuses a range its caller may not read whole.
 */
export function keySpaceRange(
  entries: readonly KeySpaceEntry[],
  grants?: readonly EtcdByteRange[],
): EtcdClient["range"] {
  const kvs: EtcdKeyValue[] = entries
    .map((entry, index) => ({
      key: encoder.encode(entry.key),
      value: encoder.encode(entry.value),
      createRevision: String(index + 2),
      modRevision: String(index + 2),
      version: "1",
      lease: "0",
    }))
    .sort((a, b) => compare(a.key, b.key));
  const intervals = grants === undefined ? undefined : merged(grants);
  return async (request: EtcdRangeRequest): Promise<EtcdRangeResponse> => {
    if (intervals !== undefined && !covered(request, intervals)) throw permissionDenied();
    const matching = kvs.filter((kv) => inRange(kv.key, request));
    const page = request.countOnly === true ? [] : matching.slice(0, request.limit);
    return {
      header: KEY_SPACE_HEADER,
      // oxlint-disable-next-line no-map-spread -- the served key-values are shared by every read, so a keys-only read answers a changed copy.
      kvs: page.map((kv) => (request.keysOnly === true ? { ...kv, value: new Uint8Array() } : kv)),
      more: request.countOnly !== true && matching.length > request.limit,
      count: String(matching.length),
    };
  };
}
