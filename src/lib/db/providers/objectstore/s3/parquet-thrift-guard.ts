/**
 * A structural check of Thrift compact bytes. Browser-safe and pure. It walks one
 * struct without building values and never allocates per declared element: a list may declare at most the bytes left
 * (every compact element takes at least one), a binary at most the bytes left, a varint at most 10 bytes, nesting at
 * most `maxDepth`, and only the types hyparquet reads (thrift.js:6-16). Every footer and page header passes it before
 * any hyparquet parser sees it.
 */

export type ThriftGuardResult =
  | { readonly ok: true; readonly end: number }
  | { readonly ok: false; readonly reason: string };

const KNOWN_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);

/** Thrown inside the walk only, carrying the refusal's reason to `guardThriftStruct`. */
class GuardStop extends Error {}

interface Walk {
  readonly bytes: Uint8Array;
  offset: number;
  readonly maxDepth: number;
  /** Called with each i16 or i32 field outside any list and its path of field ids (page headers read four of them). */
  readonly onNumber?: (path: readonly number[], value: number) => void;
}

const count = (value: number): string => value.toLocaleString("en-US");
const stop = (reason: string): never => {
  throw new GuardStop(reason);
};
const unzigzag = (value: number): number => (value % 2 === 0 ? value / 2 : -(value + 1) / 2);

function readVarint(walk: Walk): number {
  let value = 0;
  let scale = 1;
  for (let read = 0; read < 10; read += 1) {
    if (walk.offset >= walk.bytes.length) break;
    const byte = walk.bytes[walk.offset];
    walk.offset += 1;
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) return value;
    scale *= 128;
  }
  return stop("a number runs past the end");
}

function skip(walk: Walk, length: number): void {
  if (walk.offset + length > walk.bytes.length) stop("a number runs past the end");
  walk.offset += length;
}

function readByte(walk: Walk): number {
  if (walk.offset >= walk.bytes.length) stop("a struct runs past the end");
  const byte = walk.bytes[walk.offset];
  walk.offset += 1;
  return byte;
}

function walkValue(
  walk: Walk,
  type: number,
  depth: number,
  path: readonly number[] | undefined,
  inList: boolean,
): void {
  switch (type) {
    case 1:
    case 2:
      if (inList) skip(walk, 1);
      return;
    case 3:
      skip(walk, 1);
      return;
    case 4:
    case 5: {
      const value = unzigzag(readVarint(walk));
      if (path !== undefined) walk.onNumber?.(path, value);
      return;
    }
    case 6:
      readVarint(walk);
      return;
    case 7:
      skip(walk, 8);
      return;
    case 8: {
      const length = readVarint(walk);
      const left = walk.bytes.length - walk.offset;
      if (length > left) stop(`a string declares ${count(length)} bytes in ${count(left)} bytes`);
      walk.offset += length;
      return;
    }
    case 9:
      walkList(walk, depth + 1);
      return;
    default:
      walkStruct(walk, depth + 1, path);
  }
}

function walkList(walk: Walk, depth: number): void {
  if (depth > walk.maxDepth) stop(`nesting deeper than ${walk.maxDepth} levels`);
  const header = readByte(walk);
  const type = header & 0x0f;
  const size = header >> 4 === 15 ? readVarint(walk) : header >> 4;
  if (!KNOWN_TYPES.has(type)) stop(`an unknown Thrift type ${type}`);
  const left = walk.bytes.length - walk.offset;
  if (size > left) stop(`a list declares ${count(size)} elements in ${count(left)} bytes`);
  for (let element = 0; element < size; element += 1) walkValue(walk, type, depth, undefined, true);
}

function walkStruct(walk: Walk, depth: number, path: readonly number[] | undefined): void {
  if (depth > walk.maxDepth) stop(`nesting deeper than ${walk.maxDepth} levels`);
  let field = 0;
  for (;;) {
    const byte = readByte(walk);
    const type = byte & 0x0f;
    if (type === 0) return;
    if (!KNOWN_TYPES.has(type)) stop(`an unknown Thrift type ${type}`);
    const delta = byte >> 4;
    field = delta !== 0 ? field + delta : unzigzag(readVarint(walk));
    walkValue(walk, type, depth, path === undefined ? undefined : [...path, field], false);
  }
}

function run(walk: Walk): ThriftGuardResult {
  try {
    walkStruct(walk, 1, walk.onNumber === undefined ? undefined : []);
    return { ok: true, end: walk.offset };
  } catch (error) {
    // Only GuardStop is thrown inside the walk: its depth is bounded, so no stack overflow can reach here.
    return { ok: false, reason: (error as GuardStop).message };
  }
}

/** Walks one struct from `offset`; never allocates per declared element. */
export function guardThriftStruct(bytes: Uint8Array, offset: number, maxDepth: number): ThriftGuardResult {
  return run({ bytes, offset, maxDepth });
}

export interface PageHeaderFacts {
  /** Field 1: 0 data page, 1 index page, 2 dictionary page, 3 data page v2. */
  readonly type: number;
  readonly uncompressedPageSize: number;
  readonly compressedPageSize: number;
  /** Field 1 of field 5, 7 or 8; 0 when none. */
  readonly numValues: number;
  readonly headerBytes: number;
}

/** Guards, then reads the four facts of one PageHeader at `offset` (hyparquet's column.js parquetHeader). */
export function readPageHeader(
  bytes: Uint8Array,
  offset: number,
  maxDepth: number,
): PageHeaderFacts | { readonly ok: false; readonly reason: string } {
  const numbers = new Map<string, number>();
  const result = run({
    bytes,
    offset,
    maxDepth,
    onNumber: (path, value) => {
      if (path.length <= 2) numbers.set(path.join("."), value);
    },
  });
  if (!result.ok) return result;
  const uncompressedPageSize = numbers.get("2") ?? -1;
  const compressedPageSize = numbers.get("3") ?? -1;
  if (uncompressedPageSize < 0 || compressedPageSize < 0)
    return { ok: false, reason: "a page declares a negative size" };
  return {
    type: numbers.get("1") ?? -1,
    uncompressedPageSize,
    compressedPageSize,
    numValues: numbers.get("5.1") ?? numbers.get("7.1") ?? numbers.get("8.1") ?? 0,
    headerBytes: result.end - offset,
  };
}
