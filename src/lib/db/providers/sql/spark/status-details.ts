/**
 * A bounded hand decoder of the `grpc-status-details-bin` trailer Spark attaches to an error:
 * `google.rpc.Status` holding `google.rpc.ErrorInfo`, whose metadata carries Spark's errorClass, sqlState, errorId and
 * messageParameters.
 *
 * The two messages are read by hand because proto-loader builds serializers only for service methods and protobufjs
 * is a devDependency. Every read is bounded: at most 64 KiB, 16 details and 8 KiB per kept map value; a
 * value over 8 KiB drops its own key only, so errorClass and sqlState survive a long messageParameters. A response from
 * a misbehaving or untrusted server is treated as untrusted input: anything malformed answers undefined, never a throw.
 * Pure: no I/O, no logger.
 */
import {
  SPARK_STATUS_DETAILS_MAX_BYTES,
  SPARK_STATUS_DETAILS_MAX_ENTRIES,
  SPARK_STATUS_DETAILS_VALUE_MAX_BYTES,
} from "./constants";

export interface SparkErrorInfo {
  reason?: string;
  errorClass?: string;
  sqlState?: string;
  errorId?: string;
  messageParameters?: string;
}

const ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const KEPT_KEYS = ["errorClass", "sqlState", "errorId", "messageParameters"] as const;
type KeptKey = (typeof KEPT_KEYS)[number];

/**
 * Raised inside the decoder for malformed bytes; readStatusDetails turns it, and only it, into undefined. The
 * constructor is explicit because Bun's coverage never counts an implicit one as run (measured on Bun 1.4.2).
 */
class Malformed extends Error {
  constructor() {
    super("grpc-status-details-bin is malformed");
  }
}

/** Refuses bytes that are not UTF-8, and keeps a leading U+FEFF as text, as protobuf does, instead of stripping it. */
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new Malformed();
  }
}

/** A protobuf wire-format reader over one message's bytes, every step bounds-checked. */
class Reader {
  private index = 0;
  constructor(private readonly bytes: Uint8Array) {}

  done(): boolean {
    return this.index >= this.bytes.length;
  }

  /**
   * At most ten bytes. Every byte counts: a value past 2^53 rounds but keeps its size, so it never reads as a small
   * length or field number.
   */
  varint(): number {
    let result = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (this.index >= this.bytes.length) throw new Malformed();
      const byte = this.bytes[this.index] as number;
      this.index += 1;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
    }
    throw new Malformed();
  }

  /**
   * The tag's field number and wire type. The wire type is the low three bits of the tag's first byte, exact at any
   * length; past 2^53 the arithmetic rounds, so only the field number is approximate, and it is then far beyond any
   * field read here.
   */
  tag(): { readonly field: number; readonly wire: number } {
    const first = this.index;
    const key = this.varint();
    return { field: Math.floor(key / 8), wire: (this.bytes[first] as number) & 7 };
  }

  delimited(): Uint8Array {
    const length = this.varint();
    if (length > this.bytes.length - this.index) throw new Malformed();
    const slice = this.bytes.subarray(this.index, this.index + length);
    this.index += length;
    return slice;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.advance(8);
    else if (wire === 2) this.delimited();
    else if (wire === 5) this.advance(4);
    else throw new Malformed();
  }

  private advance(count: number): void {
    if (count > this.bytes.length - this.index) throw new Malformed();
    this.index += count;
  }
}

function readErrorInfo(bytes: Uint8Array): SparkErrorInfo {
  const reader = new Reader(bytes);
  let reason: string | undefined;
  const kept = new Map<KeptKey, string>();
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      reason = text(reader.delimited());
    } else if (field === 3 && wire === 2) {
      const entry = new Reader(reader.delimited());
      let key: string | undefined;
      let value: Uint8Array | undefined;
      while (!entry.done()) {
        const inner = entry.tag();
        if (inner.field === 1 && inner.wire === 2) key = text(entry.delimited());
        else if (inner.field === 2 && inner.wire === 2) value = entry.delimited();
        else entry.skip(inner.wire);
      }
      const name = KEPT_KEYS.find((candidate) => candidate === key);
      if (name === undefined) continue;
      if (value !== undefined && value.length > SPARK_STATUS_DETAILS_VALUE_MAX_BYTES) {
        kept.delete(name);
        continue;
      }
      kept.set(name, value === undefined ? "" : text(value));
    } else {
      reader.skip(wire);
    }
  }
  return {
    ...(reason === undefined || reason === "" ? {} : { reason }),
    ...Object.fromEntries(KEPT_KEYS.filter((key) => kept.has(key)).map((key) => [key, kept.get(key) as string])),
  };
}

/** The Any's ErrorInfo, or undefined for a detail of another type. */
function readAny(bytes: Uint8Array): SparkErrorInfo | undefined {
  const reader = new Reader(bytes);
  let typeUrl: string | undefined;
  let value: Uint8Array | undefined;
  while (!reader.done()) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) typeUrl = text(reader.delimited());
    else if (field === 2 && wire === 2) value = reader.delimited();
    else reader.skip(wire);
  }
  return typeUrl === ERROR_INFO_TYPE ? readErrorInfo(value ?? new Uint8Array(0)) : undefined;
}

/** Spark's ErrorInfo from `grpc-status-details-bin`, or undefined when there is none or the bytes are malformed. */
export function readStatusDetails(bytes: Uint8Array): SparkErrorInfo | undefined {
  if (bytes.length > SPARK_STATUS_DETAILS_MAX_BYTES) return undefined;
  try {
    const reader = new Reader(bytes);
    let details = 0;
    let info: SparkErrorInfo | undefined;
    while (!reader.done()) {
      const { field, wire } = reader.tag();
      if (field === 3 && wire === 2) {
        details += 1;
        if (details > SPARK_STATUS_DETAILS_MAX_ENTRIES) return undefined;
        const detail = readAny(reader.delimited());
        info ??= detail;
      } else {
        reader.skip(wire);
      }
    }
    return info;
  } catch (error) {
    if (error instanceof Malformed) return undefined;
    throw error;
  }
}
