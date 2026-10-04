/**
 * The Oxia provider's routing, pure: the shape check of a shard-assignment message (SB1-5.2, C11) and the hash the
 * server routes a key by (SB1-5.6). It dials nothing and decides no policy: which leader may be dialled is
 * `connection-options.ts`'s.
 *
 * The leader parser is a parameter (contract decision D1), so this module imports nothing but the provider's
 * constants and the seam's types, and the raw live seeder can load it as well as the adapter.
 */
import type { OxiaEndpoint, OxiaShard, OxiaSnapshot } from "./client";
import { OXIA_LEADER_MAX_BYTES, OXIA_MAX_SHARDS } from "./constants";

export type SnapshotProblem =
  | "namespace-missing"
  | "too-many-shards"
  | "no-shards"
  | "duplicate-id"
  | "bad-id"
  | "no-hash-range"
  | "range-gap-or-overlap"
  | "router"
  | "leader";

export interface WireAssignments {
  readonly namespaces: Readonly<
    Record<string, { readonly assignments: readonly WireShardAssignment[]; readonly shard_key_router: string }>
  >;
}
export interface WireShardAssignment {
  readonly shard: string;
  readonly leader: string;
  readonly int32_hash_range?: { readonly min_hash_inclusive: number; readonly max_hash_inclusive: number };
}

export interface ValidatedShard {
  readonly id: string;
  readonly minHash: number;
  readonly maxHash: number;
  readonly leaderRaw: string;
  readonly leader: OxiaEndpoint;
}

type WireHashRange = NonNullable<WireShardAssignment["int32_hash_range"]>;

/** The last hash of the 32-bit space; the last range ends here. */
const MAX_HASH = 0xffffffff;
/** The only key router a client can route by. */
const XXHASH3_ROUTER = "XXHASH3";
/** A non-negative decimal integer, no sign and no leading zero; its length is checked against the greatest int64. */
const SHARD_ID_PATTERN = /^(0|[1-9][0-9]*)$/;
/**
 * The greatest int64, compared as text (F19): it is not a safe integer. Derived rather than spelled, as the Kafka
 * provider derives its largest offset, so tests/unit/db/sqlite-int64.test.ts reads no restatement of SQLite's bind rule.
 */
const MAX_SHARD_ID = ((BigInt(1) << BigInt(63)) - BigInt(1)).toString();

const ENCODER = new TextEncoder();

/** The reason text of each problem, as the snapshot sentence carries it (SB1-5.2). */
export const SNAPSHOT_PROBLEM_REASONS: Readonly<Record<SnapshotProblem, string>> = {
  "namespace-missing": "the namespace is missing from the answer",
  "too-many-shards": `more than ${OXIA_MAX_SHARDS.toLocaleString("en-US")} shards`,
  "no-shards": "no shards",
  "duplicate-id": "two shards share an id",
  "bad-id": "a shard id is not a 64-bit integer",
  "no-hash-range": "a shard has no hash range",
  "range-gap-or-overlap": "the hash ranges leave a gap or overlap",
  router: `the key router is not ${XXHASH3_ROUTER}`,
  leader: `a leader address is not host:port within ${OXIA_LEADER_MAX_BYTES} bytes`,
};

/** A shard id in int64 range: fewer than 19 digits, or 19 digits at most the greatest int64 by string comparison. */
function isShardId(id: string): boolean {
  if (!SHARD_ID_PATTERN.test(id)) return false;
  return id.length < MAX_SHARD_ID.length || (id.length === MAX_SHARD_ID.length && id <= MAX_SHARD_ID);
}

const rangeOf = (assignment: WireShardAssignment): WireHashRange => assignment.int32_hash_range as WireHashRange;

/** True when the sorted ranges start at 0, each is non-empty, each starts after the previous one, and the last ends the space. */
function rangesTile(sorted: readonly WireShardAssignment[]): boolean {
  let next = 0;
  for (const assignment of sorted) {
    const range = rangeOf(assignment);
    if (range.min_hash_inclusive !== next || range.min_hash_inclusive > range.max_hash_inclusive) return false;
    next = range.max_hash_inclusive + 1;
  }
  return next === MAX_HASH + 1;
}

/** C11: the namespace's assignments sorted by minHash, or the first problem; leaders are checked for shape only. */
export function validateAssignments(
  message: WireAssignments,
  namespace: string,
  parseLeader: (raw: string) => OxiaEndpoint | undefined,
): { readonly shards: readonly ValidatedShard[] } | { readonly problem: SnapshotProblem } {
  // An own-property check: a namespace named like an Object member is missing, not found on the prototype.
  if (!Object.prototype.hasOwnProperty.call(message.namespaces, namespace)) return { problem: "namespace-missing" };
  const { assignments, shard_key_router: router } = message.namespaces[
    namespace
  ] as WireAssignments["namespaces"][string];
  if (assignments.length === 0) return { problem: "no-shards" };
  if (assignments.length > OXIA_MAX_SHARDS) return { problem: "too-many-shards" };
  if (!assignments.every((assignment) => isShardId(assignment.shard))) return { problem: "bad-id" };
  if (new Set(assignments.map((assignment) => assignment.shard)).size !== assignments.length) {
    return { problem: "duplicate-id" };
  }
  // `== null` covers an absent range and the loader's null alike.
  if (assignments.some((assignment) => assignment.int32_hash_range == null)) return { problem: "no-hash-range" };
  const sorted = [...assignments].sort(
    (left, right) => rangeOf(left).min_hash_inclusive - rangeOf(right).min_hash_inclusive,
  );
  if (!rangesTile(sorted)) return { problem: "range-gap-or-overlap" };
  if (router !== XXHASH3_ROUTER) return { problem: "router" };
  const shards: ValidatedShard[] = [];
  for (const assignment of sorted) {
    // The byte bound is checked here whatever parser is passed.
    const fits = ENCODER.encode(assignment.leader).length <= OXIA_LEADER_MAX_BYTES;
    const leader = fits ? parseLeader(assignment.leader) : undefined;
    if (leader === undefined) return { problem: "leader" };
    const range = rangeOf(assignment);
    shards.push({
      id: assignment.shard,
      minHash: range.min_hash_inclusive,
      maxHash: range.max_hash_inclusive,
      leaderRaw: assignment.leader,
      leader,
    });
  }
  return { shards };
}

// XXH3-64, seed 0, default secret: a port of the J4 prototype over BigInt. No bigint literal (TS2737 under ES2017):
// every constant, shift amounts included, is built once here.
const B0 = BigInt(0);
const B8 = BigInt(8);
const B16 = BigInt(16);
const B24 = BigInt(24);
const B28 = BigInt(28);
const B29 = BigInt(29);
const B32 = BigInt(32);
const B33 = BigInt(33);
const B35 = BigInt(35);
const B37 = BigInt(37);
const B47 = BigInt(47);
const B64 = BigInt(64);
const MASK64 = (BigInt(1) << B64) - BigInt(1);
const MASK32 = BigInt(0xffffffff);
const MASK8 = BigInt(0xff);
const P32_1 = BigInt("0x9e3779b1");
const P32_2 = BigInt("0x85ebca77");
const P32_3 = BigInt("0xc2b2ae3d");
const P64_1 = BigInt("0x9e3779b185ebca87");
const P64_2 = BigInt("0xc2b2ae3d27d4eb4f");
const P64_3 = BigInt("0x165667b19e3779f9");
const P64_4 = BigInt("0x85ebca77c2b2ae63");
const P64_5 = BigInt("0x27d4eb2f165667c5");
const PMX1 = BigInt("0x165667919e3779f9");
const PMX2 = BigInt("0x9fb21c651e98df25");
const ROTATE_49 = [BigInt(49), BigInt(64 - 49)] as const;
const ROTATE_24 = [BigInt(24), BigInt(64 - 24)] as const;
const BYTE_SHIFTS = Array.from({ length: 8 }, (_, index) => BigInt(8 * index));

const SECRET = Uint8Array.from([
  0xb8, 0xfe, 0x6c, 0x39, 0x23, 0xa4, 0x4b, 0xbe, 0x7c, 0x01, 0x81, 0x2c, 0xf7, 0x21, 0xad, 0x1c, 0xde, 0xd4, 0x6d,
  0xe9, 0x83, 0x90, 0x97, 0xdb, 0x72, 0x40, 0xa4, 0xa4, 0xb7, 0xb3, 0x67, 0x1f, 0xcb, 0x79, 0xe6, 0x4e, 0xcc, 0xc0,
  0xe5, 0x78, 0x82, 0x5a, 0xd0, 0x7d, 0xcc, 0xff, 0x72, 0x21, 0xb8, 0x08, 0x46, 0x74, 0xf7, 0x43, 0x24, 0x8e, 0xe0,
  0x35, 0x90, 0xe6, 0x81, 0x3a, 0x26, 0x4c, 0x3c, 0x28, 0x52, 0xbb, 0x91, 0xc3, 0x00, 0xcb, 0x88, 0xd0, 0x65, 0x8b,
  0x1b, 0x53, 0x2e, 0xa3, 0x71, 0x64, 0x48, 0x97, 0xa2, 0x0d, 0xf9, 0x4e, 0x38, 0x19, 0xef, 0x46, 0xa9, 0xde, 0xac,
  0xd8, 0xa8, 0xfa, 0x76, 0x3f, 0xe3, 0x9c, 0x34, 0x3f, 0xf9, 0xdc, 0xbb, 0xc7, 0xc7, 0x0b, 0x4f, 0x1d, 0x8a, 0x51,
  0xe0, 0x4b, 0xcd, 0xb4, 0x59, 0x31, 0xc8, 0x9f, 0x7e, 0xc9, 0xd9, 0x78, 0x73, 0x64, 0xea, 0xc5, 0xac, 0x83, 0x34,
  0xd3, 0xeb, 0xc3, 0xc5, 0x81, 0xa0, 0xff, 0xfa, 0x13, 0x63, 0xeb, 0x17, 0x0d, 0xdd, 0x51, 0xb7, 0xf0, 0xda, 0x49,
  0xd3, 0x16, 0x55, 0x26, 0x29, 0xd4, 0x68, 0x9e, 0x2b, 0x16, 0xbe, 0x58, 0x7d, 0x47, 0xa1, 0xfc, 0x8f, 0xf8, 0xb8,
  0xd1, 0x7a, 0xd0, 0x31, 0xce, 0x45, 0xcb, 0x3a, 0x8f, 0x95, 0x16, 0x04, 0x28, 0xaf, 0xd7, 0xfb, 0xca, 0xbb, 0x4b,
  0x40, 0x7e,
]);
const SECRET_VIEW = new DataView(SECRET.buffer);
/** Bytes of the default secret. */
const SECRET_SIZE = 192;
/** Bytes of one stripe of the long path. */
const STRIPE = 64;
/** Stripes of one block of the long path. */
const STRIPES_PER_BLOCK = 16;
/** Bytes of one block of the long path. */
const BLOCK = STRIPE * STRIPES_PER_BLOCK;

const s64 = (offset: number): bigint => SECRET_VIEW.getBigUint64(offset, true);
const s32 = (offset: number): bigint => BigInt(SECRET_VIEW.getUint32(offset, true));
const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK64;
const rotl = (x: bigint, [left, right]: readonly [bigint, bigint]): bigint => ((x << left) | (x >> right)) & MASK64;
function swap64(x: bigint): bigint {
  let result = B0;
  for (const shift of BYTE_SHIFTS) result = (result << B8) | ((x >> shift) & MASK8);
  return result;
}
function fold(a: bigint, b: bigint): bigint {
  const product = a * b;
  return (product & MASK64) ^ (product >> B64);
}
function avalanche64(input: bigint): bigint {
  let h = input;
  h ^= h >> B33;
  h = mul(h, P64_2);
  h ^= h >> B29;
  h = mul(h, P64_3);
  h ^= h >> B32;
  return h;
}
function avalanche3(input: bigint): bigint {
  let h = input;
  h ^= h >> B37;
  h = mul(h, PMX1);
  h ^= h >> B32;
  return h;
}
function rrmxmx(input: bigint, length: number): bigint {
  let h = input;
  h ^= rotl(h, ROTATE_49) ^ rotl(h, ROTATE_24);
  h = mul(h, PMX2);
  h ^= ((h >> B35) + BigInt(length)) & MASK64;
  h = mul(h, PMX2);
  h ^= h >> B28;
  return h;
}

/** XXH3-64 of the bytes, every length class of the reference: 0, 1 to 3, 4 to 8, 9 to 16, 17 to 128, 129 to 240, longer. */
function xxh3of64(input: Uint8Array): bigint {
  const length = input.length;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const r64 = (offset: number): bigint => view.getBigUint64(offset, true);
  const r32 = (offset: number): bigint => BigInt(view.getUint32(offset, true));
  const mix16 = (inputOffset: number, secretOffset: number): bigint =>
    fold(r64(inputOffset) ^ s64(secretOffset), r64(inputOffset + 8) ^ s64(secretOffset + 8));
  if (length === 0) return avalanche64(s64(56) ^ s64(64));
  if (length <= 3) {
    const combined =
      (BigInt(input[0] as number) << B16) |
      (BigInt(input[length >> 1] as number) << B24) |
      BigInt(input[length - 1] as number) |
      (BigInt(length) << B8);
    return avalanche64(combined ^ (s32(0) ^ s32(4)));
  }
  if (length <= 8) {
    const in64 = (r32(length - 4) + (r32(0) << B32)) & MASK64;
    return rrmxmx(in64 ^ (s64(8) ^ s64(16)), length);
  }
  if (length <= 16) {
    const low = r64(0) ^ (s64(24) ^ s64(32));
    const high = r64(length - 8) ^ (s64(40) ^ s64(48));
    return avalanche3((BigInt(length) + swap64(low) + high + fold(low, high)) & MASK64);
  }
  if (length <= 128) {
    let acc = mul(BigInt(length), P64_1);
    if (length > 32) {
      if (length > 64) {
        if (length > 96) {
          acc += mix16(48, 96);
          acc += mix16(length - 64, 112);
        }
        acc += mix16(32, 64);
        acc += mix16(length - 48, 80);
      }
      acc += mix16(16, 32);
      acc += mix16(length - 32, 48);
    }
    acc += mix16(0, 0);
    acc += mix16(length - 16, 16);
    return avalanche3(acc & MASK64);
  }
  if (length <= 240) {
    let acc = mul(BigInt(length), P64_1);
    const rounds = Math.floor(length / 16);
    for (let index = 0; index < 8; index++) acc = (acc + mix16(16 * index, 16 * index)) & MASK64;
    acc = avalanche3(acc);
    for (let index = 8; index < rounds; index++) acc = (acc + mix16(16 * index, 16 * (index - 8) + 3)) & MASK64;
    acc = (acc + mix16(length - 16, 136 - 17)) & MASK64;
    return avalanche3(acc);
  }
  // The long path: 64-byte stripes, 16 stripes to a 1,024-byte block, the 192-byte secret.
  const acc = [P32_3, P64_1, P64_2, P64_3, P64_4, P32_2, P64_5, P32_1];
  const stripe = (inputOffset: number, secretOffset: number): void => {
    for (let lane = 0; lane < 8; lane++) {
      const data = r64(inputOffset + 8 * lane);
      const keyed = data ^ s64(secretOffset + 8 * lane);
      acc[lane ^ 1] = ((acc[lane ^ 1] as bigint) + data) & MASK64;
      acc[lane] = ((acc[lane] as bigint) + (keyed & MASK32) * (keyed >> B32)) & MASK64;
    }
  };
  const scramble = (): void => {
    for (let lane = 0; lane < 8; lane++) {
      let value = acc[lane] as bigint;
      value ^= value >> B47;
      value ^= s64(SECRET_SIZE - STRIPE + 8 * lane);
      acc[lane] = mul(value, P32_1);
    }
  };
  const blocks = Math.floor((length - 1) / BLOCK);
  for (let block = 0; block < blocks; block++) {
    for (let index = 0; index < STRIPES_PER_BLOCK; index++) stripe(block * BLOCK + index * STRIPE, index * 8);
    scramble();
  }
  const stripes = Math.floor((length - 1 - BLOCK * blocks) / STRIPE);
  for (let index = 0; index < stripes; index++) stripe(blocks * BLOCK + index * STRIPE, index * 8);
  stripe(length - STRIPE, SECRET_SIZE - STRIPE - 7);
  let result = mul(BigInt(length), P64_1);
  for (let index = 0; index < 4; index++) {
    const left = (acc[2 * index] as bigint) ^ s64(11 + 16 * index);
    const right = (acc[2 * index + 1] as bigint) ^ s64(11 + 16 * index + 8);
    result = (result + fold(left, right)) & MASK64;
  }
  return avalanche3(result);
}

/** XXH3-64 (seed 0, default secret) of the bytes, low 32 bits, as Oxia's common/hash.Xxh332. */
export function xxh3Low32(bytes: Uint8Array): number {
  return Number(xxh3of64(bytes) & MASK32);
}

/** The routing hash of a key or partition key: xxh3Low32 of its UTF-8 bytes. */
export function oxiaHash(text: string): number {
  return xxh3Low32(ENCODER.encode(text));
}

/**
 * The shard whose inclusive range holds the hash: binary search over the validated, sorted snapshot.
 *
 * The snapshot must be a validated one (first range at 0, contiguous, sorted by `minHash`), so the last shard whose
 * `minHash` is at most the hash holds it. A partition key routes instead of the key, the empty one included.
 */
export function shardFor(snapshot: OxiaSnapshot, key: string, partitionKey?: string): OxiaShard {
  const hash = oxiaHash(partitionKey ?? key);
  const { shards } = snapshot;
  let low = 0;
  let high = shards.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((shards[middle] as OxiaShard).minHash <= hash) low = middle;
    else high = middle - 1;
  }
  return shards[low] as OxiaShard;
}
