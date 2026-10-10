/**
 * A Thrift compact protocol writer for test inputs: Parquet footers, page headers and the guard's hostile cases.
 * It writes what hyparquet 1.31.1's thrift.js reads (field headers with a delta or a zigzag id, zigzag varints,
 * length-prefixed binaries, list headers with a size nibble or a varint, a bool list element as one byte).
 */
export const THRIFT = {
  TRUE: 1,
  FALSE: 2,
  BYTE: 3,
  I16: 4,
  I32: 5,
  I64: 6,
  DOUBLE: 7,
  BINARY: 8,
  LIST: 9,
  STRUCT: 12,
} as const;

export type ThriftValue =
  | { readonly i32: number }
  | { readonly i64: number | bigint }
  | { readonly binary: string | Uint8Array }
  | { readonly bool: boolean }
  | { readonly list: { readonly type: number; readonly items: readonly ThriftValue[] } }
  | { readonly struct: readonly ThriftField[] };

export type ThriftField = readonly [number, ThriftValue];

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const SEVEN = BigInt(7);
const LOW_SEVEN_BITS = BigInt(127);

/** Unsigned LEB128. */
export function varint(value: number | bigint): number[] {
  let rest = BigInt(value);
  const out: number[] = [];
  while (rest > LOW_SEVEN_BITS) {
    out.push(Number(rest & LOW_SEVEN_BITS) | 128);
    rest >>= SEVEN;
  }
  out.push(Number(rest));
  return out;
}

const zigzag = (value: number | bigint): bigint => {
  const signed = BigInt(value);
  return signed >= ZERO ? signed * TWO : -signed * TWO - ONE;
};

function typeOf(value: ThriftValue): number {
  if ("i32" in value) return THRIFT.I32;
  if ("i64" in value) return THRIFT.I64;
  if ("binary" in value) return THRIFT.BINARY;
  if ("bool" in value) return value.bool ? THRIFT.TRUE : THRIFT.FALSE;
  if ("list" in value) return THRIFT.LIST;
  return THRIFT.STRUCT;
}

function pushAll(out: number[], values: Iterable<number>): void {
  for (const value of values) out.push(value);
}

function writeValue(out: number[], value: ThriftValue, inList: boolean): void {
  if ("i32" in value) pushAll(out, varint(zigzag(value.i32)));
  else if ("i64" in value) pushAll(out, varint(zigzag(value.i64)));
  else if ("binary" in value) {
    const bytes = typeof value.binary === "string" ? new TextEncoder().encode(value.binary) : value.binary;
    pushAll(out, varint(bytes.length));
    pushAll(out, bytes);
  } else if ("bool" in value) {
    if (inList) out.push(value.bool ? 1 : 0);
  } else if ("list" in value) {
    const { type, items } = value.list;
    if (items.length < 15) out.push((items.length << 4) | type);
    else {
      out.push(0xf0 | type);
      pushAll(out, varint(items.length));
    }
    for (const item of items) writeValue(out, item, true);
  } else writeStructBody(out, value.struct);
}

function writeStructBody(out: number[], fields: readonly ThriftField[]): void {
  let last = 0;
  for (const [id, value] of fields) {
    const type = typeOf(value);
    const delta = id - last;
    if (delta > 0 && delta <= 15) out.push((delta << 4) | type);
    else {
      out.push(type);
      pushAll(out, varint(zigzag(id)));
    }
    writeValue(out, value, false);
    last = id;
  }
  out.push(0);
}

/** One struct, fields in the order given, ended by its stop byte. */
export function thriftStruct(fields: readonly ThriftField[]): Uint8Array {
  const out: number[] = [];
  writeStructBody(out, fields);
  return Uint8Array.from(out);
}
