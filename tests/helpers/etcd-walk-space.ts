/**
 * An in-memory etcd key space that answers `range` as etcd does, for the walks of spec 4.3 and 4.6 over
 * `createFakeEtcdClient`.
 *
 * Keys are held in byte order, so a page is the next `limit` keys from the request's key, `more` says
 * whether the range held more, and `count` is the whole range's count whatever the limit, as etcd reports
 * it (SRC `etcd__api_etcdserverpb_rpc.proto`, RangeResponse.count). A range with no end, or with an empty
 * one, is the one key, and a range end of one 0x00 byte runs to the end. A request the union of
 * `readable`'s ranges does not cover is refused whole with etcd's PermissionDenied, as etcd refuses a
 * range the caller's grants do not cover (R06 4.2): etcd holds a single-key grant as the interval from the
 * key to the key and a 0x00 byte, and asks whether its merged grants contain the request (SRC
 * `etcd__server_auth_range_perm_cache.go`, `getMergedPerms` and `checkKeyInterval`). The header's revision
 * is the space's current one, never the revision a request reads at, as etcd answers a historical read.
 * A request with no positive limit is a defect of the module that sent it (spec E14) and is raised as one.
 */
import {
  type EtcdByteRange,
  type EtcdBytes,
  EtcdError,
  type EtcdRangeRequest,
  type EtcdRangeResponse,
} from "@/lib/db/providers/keyvalue/etcd/client";

export const enc = (text: string): EtcdBytes => new TextEncoder().encode(text);

function compareBytes(a: EtcdBytes, b: EtcdBytes): number {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

const toEnd = (bytes: EtcdBytes): boolean => bytes.length === 1 && bytes[0] === 0;

/** The first index whose key is at or after `key`. */
function lowerBound(sorted: readonly EtcdBytes[], key: EtcdBytes): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareBytes(sorted[middle], key) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The range end a range names, or undefined for the one key: etcd reads no end and an empty end alike. */
const endOf = (range: EtcdByteRange): EtcdBytes | undefined =>
  range.rangeEnd === undefined || range.rangeEnd.length === 0 ? undefined : range.rangeEnd;

/** A range as the interval etcd's permission check reads: [start, end), `end` undefined running to the end. */
function interval(range: EtcdByteRange): { readonly start: EtcdBytes; readonly end?: EtcdBytes } {
  const end = endOf(range);
  if (end === undefined) return { start: range.key, end: new Uint8Array([...range.key, 0]) };
  return toEnd(end) ? { start: range.key } : { start: range.key, end };
}

/** Whether the union of `grants` contains every key `request` names. */
function covered(request: EtcdByteRange, grants: readonly EtcdByteRange[]): boolean {
  const merged: { start: EtcdBytes; end?: EtcdBytes }[] = [];
  for (const grant of grants.map(interval).sort((a, b) => compareBytes(a.start, b.start))) {
    const last = merged[merged.length - 1];
    if (last !== undefined && (last.end === undefined || compareBytes(grant.start, last.end) <= 0)) {
      if (last.end !== undefined && (grant.end === undefined || compareBytes(grant.end, last.end) > 0)) {
        last.end = grant.end;
      }
    } else {
      merged.push({ ...grant });
    }
  }
  const wanted = interval(request);
  return merged.some(
    (grant) =>
      compareBytes(wanted.start, grant.start) >= 0 &&
      (grant.end === undefined || (wanted.end !== undefined && compareBytes(wanted.end, grant.end) <= 0)),
  );
}

export interface EtcdWalkSpaceOptions {
  /** The space's current revision, in every header; "100" when absent. */
  readonly revision?: string;
  /** The ranges the caller's grants cover; absent reads everything. */
  readonly readable?: readonly EtcdByteRange[];
}

export interface EtcdWalkSpace {
  /** A `range` stub for `createFakeEtcdClient`. */
  readonly range: (request: EtcdRangeRequest) => Promise<EtcdRangeResponse>;
  /** The keys the space holds, in byte order. */
  readonly keys: readonly EtcdBytes[];
  /** How many keys it has handed out so far, so a test can hold a walk to what it read. */
  readonly served: () => number;
}

export function etcdWalkSpace(keys: Iterable<string | EtcdBytes>, options: EtcdWalkSpaceOptions = {}): EtcdWalkSpace {
  const sorted = [...keys].map((key) => (typeof key === "string" ? enc(key) : key)).sort(compareBytes);
  const revision = options.revision ?? "100";
  let served = 0;
  return {
    keys: sorted,
    served: () => served,
    range: async (request) => {
      // A limit of 0 reads a whole range, so no module may send one (spec E14): a defect, raised as itself.
      if (!(request.limit > 0)) throw new Error("The fake key space was sent a Range with no positive limit");
      if (options.readable !== undefined && !covered(request, options.readable)) {
        throw new EtcdError("permission-denied", "etcdserver: permission denied", 7);
      }
      const start = lowerBound(sorted, request.key);
      const rangeEnd = endOf(request);
      const end =
        rangeEnd === undefined
          ? start + (start < sorted.length && compareBytes(sorted[start], request.key) === 0 ? 1 : 0)
          : toEnd(rangeEnd)
            ? sorted.length
            : lowerBound(sorted, rangeEnd);
      const held = Math.max(0, end - start);
      const taken = request.countOnly === true ? [] : sorted.slice(start, start + Math.min(request.limit, held));
      served += taken.length;
      return {
        header: { clusterId: "1", memberId: "2", revision, raftTerm: "3" },
        kvs: taken.map((key) => ({
          key,
          value: new Uint8Array(0),
          createRevision: "1",
          modRevision: "1",
          version: "1",
          lease: "0",
        })),
        more: request.countOnly !== true && held > request.limit,
        count: String(held),
      };
    },
  };
}
