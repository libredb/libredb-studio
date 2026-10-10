/**
 * A structural check of Thrift compact bytes. Browser-safe and pure. It walks one
 * struct without building values and never allocates per declared element: a list may declare at most the bytes left
 * (every compact element takes at least one), a binary at most the bytes left, nesting at most `maxDepth`, and only
 * the types hyparquet reads (thrift.js:6-16). Every footer and page header passes it before any hyparquet parser sees
 * it. A caller may also cap the list elements and the fields of the whole struct, since hyparquet builds an object or
 * a value for each list element and a property for each field.
 *
 * It accepts only bytes hyparquet's reader reads to the same values. hyparquet decodes a varint with 32-bit bitwise
 * arithmetic, so a field id, an i16, an i32, a binary length or a list size may take at most 5 bytes, the fifth
 * holding no bit past 32, and is decoded with hyparquet's own expressions; an i64 may take 10 bytes. A long-form field
 * id must lie in 1 to 32,767, and a length or size that reads as negative is refused.
 */

export type ThriftGuardResult =
  | { readonly ok: true; readonly end: number }
  | { readonly ok: false; readonly reason: string };

const KNOWN_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);

/** Thrown inside the walk only, carrying the refusal's reason to `guardThriftStruct`. */
class GuardStop extends Error {}

export interface ThriftGuardOptions {
  /** The most elements all lists of the struct may declare together, at any depth. */
  readonly maxListElements?: number;
  /** The most fields all structs may declare together, at any depth and inside lists; checked before each is walked. */
  readonly maxFields?: number;
  /**
   * Called with each field outside any list, after its value: its path of field ids, its Thrift type, and its value
   * when an i16 or i32, or its declared size when a list.
   */
  readonly onField?: (path: readonly number[], type: number, value: number | undefined) => void;
}

interface Walk {
  readonly bytes: Uint8Array;
  offset: number;
  readonly maxDepth: number;
  readonly maxListElements: number;
  listElements: number;
  readonly maxFields: number;
  fields: number;
  readonly onField?: ThriftGuardOptions["onField"];
}

const count = (value: number): string => value.toLocaleString("en-US");
const stop = (reason: string): never => {
  throw new GuardStop(reason);
};
/** hyparquet's zigzag decode of a 32-bit varint (thrift.js readZigZag). */
const unzigzag = (zigzag: number): number => (zigzag >>> 1) ^ -(zigzag & 1);

/** Skips an i64 varint of at most 10 bytes; hyparquet reads it as a bigint, which the guard never reports. */
function skipVarint64(walk: Walk): void {
  for (let read = 0; read < 10; read += 1) {
    if (walk.offset >= walk.bytes.length) break;
    const byte = walk.bytes[walk.offset];
    walk.offset += 1;
    if ((byte & 0x80) === 0) return;
  }
  stop("a number runs past the end");
}

/** A 32-bit varint as hyparquet's readVarInt computes it: at most 5 bytes, the fifth no larger than 0x0f. */
function readVarint32(walk: Walk): number {
  let result = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    if (walk.offset >= walk.bytes.length) break;
    const byte = walk.bytes[walk.offset];
    walk.offset += 1;
    if (shift === 28 && byte > 0x0f) stop("a number takes more than 32 bits");
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
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

/** Walks one value; returns an i16 or i32 value, or a list's declared size. */
function walkValue(
  walk: Walk,
  type: number,
  depth: number,
  path: readonly number[] | undefined,
  inList: boolean,
): number | undefined {
  switch (type) {
    case 1:
    case 2:
      if (inList) skip(walk, 1);
      return undefined;
    case 3:
      skip(walk, 1);
      return undefined;
    case 4:
    case 5:
      return unzigzag(readVarint32(walk));
    case 6:
      skipVarint64(walk);
      return undefined;
    case 7:
      skip(walk, 8);
      return undefined;
    case 8: {
      const length = readVarint32(walk);
      const left = walk.bytes.length - walk.offset;
      if (length < 0 || length > left) stop(`a string declares ${count(length)} bytes in ${count(left)} bytes`);
      walk.offset += length;
      return undefined;
    }
    case 9:
      return walkList(walk, depth + 1);
    default:
      walkStruct(walk, depth + 1, path);
      return undefined;
  }
}

function walkList(walk: Walk, depth: number): number {
  if (depth > walk.maxDepth) stop(`nesting deeper than ${walk.maxDepth} levels`);
  const header = readByte(walk);
  const type = header & 0x0f;
  const size = header >> 4 === 15 ? readVarint32(walk) : header >> 4;
  if (!KNOWN_TYPES.has(type)) stop(`an unknown Thrift type ${type}`);
  const left = walk.bytes.length - walk.offset;
  if (size < 0 || size > left) stop(`a list declares ${count(size)} elements in ${count(left)} bytes`);
  walk.listElements += size;
  if (walk.listElements > walk.maxListElements)
    stop(`the lists declare more than ${count(walk.maxListElements)} elements in all`);
  for (let element = 0; element < size; element += 1) walkValue(walk, type, depth, undefined, true);
  return size;
}

function walkStruct(walk: Walk, depth: number, path: readonly number[] | undefined): void {
  if (depth > walk.maxDepth) stop(`nesting deeper than ${walk.maxDepth} levels`);
  let field = 0;
  for (;;) {
    const byte = readByte(walk);
    const type = byte & 0x0f;
    if (type === 0) return;
    if (!KNOWN_TYPES.has(type)) stop(`an unknown Thrift type ${type}`);
    walk.fields += 1;
    if (walk.fields > walk.maxFields) stop(`the structs declare more than ${count(walk.maxFields)} fields in all`);
    const delta = byte >> 4;
    if (delta !== 0) field += delta;
    else {
      field = unzigzag(readVarint32(walk));
      if (field < 1 || field > 32_767) stop("a field id outside 1 to 32,767");
    }
    const fieldPath = path === undefined ? undefined : [...path, field];
    const value = walkValue(walk, type, depth, fieldPath, false);
    if (fieldPath !== undefined) walk.onField?.(fieldPath, type, value);
  }
}

function run(walk: Walk): ThriftGuardResult {
  try {
    walkStruct(walk, 1, walk.onField === undefined ? undefined : []);
    return { ok: true, end: walk.offset };
  } catch (error) {
    // Only GuardStop is thrown inside the walk: its depth is bounded, so no stack overflow can reach here.
    return { ok: false, reason: (error as GuardStop).message };
  }
}

/** Walks one struct from `offset`; never allocates per declared element. */
export function guardThriftStruct(
  bytes: Uint8Array,
  offset: number,
  maxDepth: number,
  options: ThriftGuardOptions = {},
): ThriftGuardResult {
  return run({
    bytes,
    offset,
    maxDepth,
    maxListElements: options.maxListElements ?? Number.POSITIVE_INFINITY,
    listElements: 0,
    maxFields: options.maxFields ?? Number.POSITIVE_INFINITY,
    fields: 0,
    onField: options.onField,
  });
}

export interface PageHeaderFacts {
  /** Field 1: 0 data page, 1 index page, 2 dictionary page, 3 data page v2. */
  readonly type: number;
  readonly uncompressedPageSize: number;
  readonly compressedPageSize: number;
  /** Field 1 of field 5 for a data page, of field 7 for a dictionary page, of field 8 for a data page v2; 0 for an index page. */
  readonly numValues: number;
  readonly headerBytes: number;
}

/** The field holding the value count of each page type, as hyparquet's readPage reads it (column.js:96-141). */
const COUNT_HOLDER: Readonly<Record<number, number>> = { 0: 5, 2: 7, 3: 8 };

/** The page header fields the facts read; the reader records no other. */
const FACT_KEYS: ReadonlySet<string> = new Set(["1", "2", "3", "5", "7", "8", "5.1", "7.1", "8.1", "8.2"]);

/**
 * A page header's bounds. The format's PageHeader holds at most 8 fields, its largest nested header 8 more and a
 * Statistics struct 8 more, and none of them holds a list, so these bound what hyparquet builds from one header
 * without refusing any header a writer emits.
 */
const PAGE_HEADER_MAX_FIELDS = 64;
const PAGE_HEADER_MAX_LIST_ELEMENTS = 8;

interface SeenField {
  readonly type: number;
  readonly value: number | undefined;
  readonly times: number;
}

/**
 * Guards, then reads the four facts of one PageHeader at `offset` the way hyparquet's column.js parquetHeader and
 * readPage read them, so a count the guard checks is the count hyparquet allocates from: the count comes from the
 * holder the page type names, every fact must be an i16 or i32 that appears once, and a data page v2's null count,
 * which hyparquet subtracts from its count, must lie between 0 and that count.
 */
export function readPageHeader(
  bytes: Uint8Array,
  offset: number,
  maxDepth: number,
): PageHeaderFacts | { readonly ok: false; readonly reason: string } {
  const fields = new Map<string, SeenField>();
  const result = guardThriftStruct(bytes, offset, maxDepth, {
    maxFields: PAGE_HEADER_MAX_FIELDS,
    maxListElements: PAGE_HEADER_MAX_LIST_ELEMENTS,
    onField: (path, type, value) => {
      if (path.length > 2) return;
      const key = path.join(".");
      if (!FACT_KEYS.has(key)) return;
      fields.set(key, { type, value, times: (fields.get(key)?.times ?? 0) + 1 });
    },
  });
  if (!result.ok) return result;
  const once = (key: string): SeenField | undefined => {
    const field = fields.get(key);
    if (field !== undefined && field.times > 1) stop(`page header field ${key} appears more than once`);
    return field;
  };
  const integer = (key: string): number | undefined => {
    const field = once(key);
    if (field === undefined) return undefined;
    if (field.type !== 4 && field.type !== 5) stop(`page header field ${key} is not a 16-bit or 32-bit integer`);
    return field.value;
  };
  try {
    const type = integer("1");
    const uncompressedPageSize = integer("2") ?? -1;
    const compressedPageSize = integer("3") ?? -1;
    if (uncompressedPageSize < 0 || compressedPageSize < 0) stop("a page declares a negative size");
    if (type === undefined) return stop("a page declares no type");
    let numValues = 0;
    if (type !== 1) {
      const holder = COUNT_HOLDER[type];
      if (holder === undefined) stop(`a page declares an unknown type ${type}`);
      if (once(`${holder}`)?.type !== 12) stop(`a page of type ${type} has no field ${holder}`);
      numValues = integer(`${holder}.1`) ?? stop(`a page of type ${type} has no value count`);
      if (type === 3) {
        const nulls = integer("8.2") ?? stop("a data page v2 has no null count");
        if (nulls < 0 || nulls > numValues) stop("a data page v2 declares a null count outside 0 to its values");
      }
    }
    return { type, uncompressedPageSize, compressedPageSize, numValues, headerBytes: result.end - offset };
  } catch (error) {
    return { ok: false, reason: (error as GuardStop).message };
  }
}
