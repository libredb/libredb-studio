/**
 * The content-header walk: class, body size, property flags, the basic properties and the headers table.
 *
 * A CONTENT-HEADER FRAME IS NEVER HELD WHOLE. RabbitMQ sends header frames above the negotiated frame size, and one can
 * be a 300 MiB table, so this walk is a generator the frame reader drives with the frame's bytes as they arrive: it
 * asks for a few bytes at a time (`take`), or for a run of bytes it will not keep (`skip`), and keeps no buffer larger
 * than the retained table limit. Nesting is walked with an explicit stack, never by recursion, and a container deeper
 * than RABBITMQ_HEADER_DEPTH is stepped over by its length and marked.
 *
 * Tags follow RabbitMQ's table (its errata): `s` is a signed 16-bit integer, `l` and `L` are signed 64-bit, `x` is a
 * byte array, and `D` is a signed decimal. Any other tag, `U` included, is a protocol violation.
 */
import type { ProtocolFact } from "../errors";
import {
  RABBITMQ_HEADER_DEPTH,
  RABBITMQ_HEADER_TABLE_RETAINED_BYTES,
  RABBITMQ_HEADER_VALUE_RETAINED_BYTES,
} from "../limits";
import { ProtocolViolation } from "./codec";

export type FieldValue =
  | { readonly tag: "S" | "x"; readonly bytes: Uint8Array }
  | { readonly tag: "t"; readonly value: boolean }
  | { readonly tag: "b" | "B" | "s" | "u" | "I" | "i" | "f" | "d"; readonly value: number }
  | { readonly tag: "l" | "L" | "T"; readonly value: bigint }
  | { readonly tag: "D"; readonly scale: number; readonly value: number }
  | { readonly tag: "V" }
  | { readonly tag: "F"; readonly entries: readonly FieldEntry[] }
  | { readonly tag: "A"; readonly items: readonly FieldValue[] }
  | { readonly tag: "omitted"; readonly bytes: number }
  | { readonly tag: "too-deep"; readonly bytes: number };

export interface FieldEntry {
  /** Raw bytes; render.ts decodes them. */
  readonly name: Uint8Array;
  readonly value: FieldValue;
}

export interface BasicProperties {
  readonly contentType?: Uint8Array;
  readonly contentEncoding?: Uint8Array;
  /** `x-stream-offset` is kept here; render.ts removes it. */
  readonly headers?: readonly FieldEntry[];
  /**
   * Entries the walk read but did not keep at all, once the retained table limit was spent even on their names: their
   * count and their bytes on the wire. Absent when every entry was kept, as a value or as a marker.
   */
  readonly headersOmitted?: { readonly entries: number; readonly bytes: number };
  readonly deliveryMode?: number;
  readonly priority?: number;
  readonly correlationId?: Uint8Array;
  readonly replyTo?: Uint8Array;
  readonly expiration?: Uint8Array;
  readonly messageId?: Uint8Array;
  readonly timestamp?: bigint;
  readonly type?: Uint8Array;
  readonly userId?: Uint8Array;
  readonly appId?: Uint8Array;
  readonly clusterId?: Uint8Array;
}

/** What the walk asks its driver for: `take` answers a fresh copy of n bytes, `skip` steps over n bytes. */
export type Need = { readonly take: number } | { readonly skip: number };

export interface ContentHeaderHooks {
  /** The declared body size, before any property is read; throws a ProtocolViolation to refuse it. */
  bodySize(size: bigint): void;
  /** `x-stream-offset` of type `l` in the headers table, as soon as it is decoded. */
  streamOffset(offset: bigint): void;
}

export interface ContentHeader {
  readonly bodySize: bigint;
  readonly properties: BasicProperties;
  /** Every byte kept for this header, the per-entry cost included; counted against the result budget. */
  readonly retainedBytes: number;
}

/**
 * What one kept entry costs beyond its bytes: the objects that hold it. Counting it makes the retained limit bound the
 * memory a table of many tiny entries takes, not only its bytes.
 */
export const ENTRY_OVERHEAD_BYTES = 64;
const BASIC_CLASS = 60;
const OFFSET_KEY = new TextEncoder().encode("x-stream-offset");
const FIXED_SIZE: Readonly<Record<string, number>> = {
  t: 1,
  b: 1,
  B: 1,
  s: 2,
  u: 2,
  I: 4,
  i: 4,
  l: 8,
  L: 8,
  T: 8,
  f: 4,
  d: 8,
  D: 5,
  V: 0,
};

const violation = (fact: ProtocolFact): ProtocolViolation => new ProtocolViolation(fact, 501);

function fixedValue(tag: string, bytes: Uint8Array): FieldValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (tag) {
    case "t":
      return { tag, value: bytes[0] !== 0 };
    case "b":
      return { tag, value: view.getInt8(0) };
    case "B":
      return { tag, value: view.getUint8(0) };
    case "s":
      return { tag, value: view.getInt16(0) };
    case "u":
      return { tag, value: view.getUint16(0) };
    case "I":
      return { tag, value: view.getInt32(0) };
    case "i":
      return { tag, value: view.getUint32(0) };
    case "l":
    case "L":
      return { tag, value: view.getBigInt64(0) };
    case "T":
      return { tag, value: view.getBigUint64(0) };
    case "f":
      return { tag, value: view.getFloat32(0) };
    case "d":
      return { tag, value: view.getFloat64(0) };
    case "D":
      return { tag, scale: view.getUint8(0), value: view.getInt32(1) };
    default:
      return { tag: "V" };
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const u32 = (bytes: Uint8Array): number => new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);

/** One open container: where it ends in the frame, how deep it is, and what it has kept so far. */
interface Level {
  readonly end: number;
  readonly depth: number;
  readonly entries: FieldEntry[] | null;
  readonly items: FieldValue[] | null;
  /** Where the finished container goes: an entry of the parent table, or an item of the parent array. */
  readonly name: Uint8Array | null;
}

/**
 * Walks one content-header frame payload of `size` bytes. The generator yields what it needs and receives the bytes;
 * it returns the header once the payload is used up exactly, and throws a ProtocolViolation for anything malformed.
 */
export function* walkContentHeader(
  size: number,
  hooks: ContentHeaderHooks,
): Generator<Need, ContentHeader, Uint8Array> {
  let at = 0;
  let retained = 0;
  let omittedEntries = 0;
  let omittedBytes = 0;
  /** Reserves n bytes inside `end` (the frame, or the innermost container) and moves past them. */
  const reserve = (count: number, end: number): void => {
    if (count > end - at) throw violation("malformed-frame");
    at += count;
  };
  const take = (count: number, end = size): Need => {
    reserve(count, end);
    return { take: count };
  };
  const skip = (count: number, end = size): Need => {
    reserve(count, end);
    return { skip: count };
  };
  const fits = (count: number): boolean =>
    count <= RABBITMQ_HEADER_VALUE_RETAINED_BYTES && retained + count <= RABBITMQ_HEADER_TABLE_RETAINED_BYTES;

  const fixed = yield take(14);
  const head = new DataView(fixed.buffer, fixed.byteOffset, fixed.byteLength);
  if (head.getUint16(0) !== BASIC_CLASS) throw violation("malformed-frame");
  const bodySize = head.getBigUint64(4);
  hooks.bodySize(bodySize);
  const flags = head.getUint16(12);
  if ((flags & 0b11) !== 0) throw violation("malformed-frame");
  const has = (bit: number): boolean => (flags & (1 << bit)) !== 0;
  const properties: {
    -readonly [K in keyof BasicProperties]: BasicProperties[K];
  } = {};

  function* shortstr(): Generator<Need, Uint8Array, Uint8Array> {
    const length = (yield take(1))[0] as number;
    const bytes = yield take(length);
    retained += length;
    return bytes;
  }

  if (has(15)) properties.contentType = yield* shortstr();
  if (has(14)) properties.contentEncoding = yield* shortstr();
  if (has(13)) {
    const tableLength = u32(yield take(4));
    const tableEnd = at + tableLength;
    if (tableLength > size - at) throw violation("malformed-frame");
    const top: FieldEntry[] = [];
    const stack: Level[] = [{ end: tableEnd, depth: 1, entries: top, items: null, name: null }];
    let offsetSeen = false;
    while (stack.length > 0) {
      const level = stack[stack.length - 1] as Level;
      if (at === level.end) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent !== undefined) {
          const value: FieldValue =
            level.entries !== null ? { tag: "F", entries: level.entries } : { tag: "A", items: level.items ?? [] };
          if (parent.entries !== null) parent.entries.push({ name: level.name ?? new Uint8Array(0), value });
          else parent.items?.push(value);
        }
        continue;
      }
      const entryStart = at;
      let name: Uint8Array | null = null;
      if (level.entries !== null) {
        const length = (yield take(1, level.end))[0] as number;
        name = yield take(length, level.end);
      }
      const tag = String.fromCharCode((yield take(1, level.end))[0] as number);
      const isOffset = level.depth === 1 && tag === "l" && name !== null && sameBytes(name, OFFSET_KEY);
      // Only the first offset entry passes the spent limit: a repeat would otherwise be kept beyond it every time.
      const keep = (isOffset && !offsetSeen) || retained < RABBITMQ_HEADER_TABLE_RETAINED_BYTES;
      const place = (value: FieldValue): void => {
        if (!keep) {
          omittedEntries += 1;
          omittedBytes += at - entryStart;
          return;
        }
        retained += (name?.length ?? 0) + ENTRY_OVERHEAD_BYTES;
        if (level.entries !== null) level.entries.push({ name: name ?? new Uint8Array(0), value });
        else level.items?.push(value);
      };

      const width = FIXED_SIZE[tag];
      if (width !== undefined) {
        const bytes = width === 0 ? new Uint8Array(0) : yield take(width, level.end);
        const value = fixedValue(tag, bytes);
        if (isOffset && !offsetSeen) {
          offsetSeen = true;
          hooks.streamOffset((value as { value: bigint }).value);
        }
        if (keep) retained += width;
        place(value);
        continue;
      }
      if (tag !== "S" && tag !== "x" && tag !== "F" && tag !== "A") throw new ProtocolViolation("unknown-field", 501);
      const length = u32(yield take(4, level.end));
      if (length > level.end - at) throw violation("malformed-frame");
      if (tag === "S" || tag === "x") {
        if (keep && fits(length)) {
          const bytes = yield take(length, level.end);
          retained += length;
          place({ tag, bytes });
        } else {
          yield skip(length, level.end);
          place({ tag: "omitted", bytes: length });
        }
        continue;
      }
      if (!keep || !fits(length)) {
        yield skip(length, level.end);
        place({ tag: "omitted", bytes: length });
        continue;
      }
      if (level.depth + 1 > RABBITMQ_HEADER_DEPTH) {
        yield skip(length, level.end);
        place({ tag: "too-deep", bytes: length });
        continue;
      }
      retained += (name?.length ?? 0) + ENTRY_OVERHEAD_BYTES;
      stack.push({
        end: at + length,
        depth: level.depth + 1,
        entries: tag === "F" ? [] : null,
        items: tag === "A" ? [] : null,
        name,
      });
    }
    properties.headers = top;
    if (omittedEntries > 0) properties.headersOmitted = { entries: omittedEntries, bytes: omittedBytes };
  }
  if (has(12)) properties.deliveryMode = (yield take(1))[0] as number;
  if (has(11)) properties.priority = (yield take(1))[0] as number;
  if (has(10)) properties.correlationId = yield* shortstr();
  if (has(9)) properties.replyTo = yield* shortstr();
  if (has(8)) properties.expiration = yield* shortstr();
  if (has(7)) properties.messageId = yield* shortstr();
  if (has(6)) {
    const bytes = yield take(8);
    properties.timestamp = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
  }
  if (has(5)) properties.type = yield* shortstr();
  if (has(4)) properties.userId = yield* shortstr();
  if (has(3)) properties.appId = yield* shortstr();
  if (has(2)) properties.clusterId = yield* shortstr();
  if (at !== size) throw violation("malformed-frame");
  return { bodySize, properties, retainedBytes: retained };
}
