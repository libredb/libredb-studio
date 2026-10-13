/**
 * Decoding a value out of registers, where the layout is the device's and not ours.
 *
 * WHY ORDER HAS NO DEFAULT. MEASURED by the issue author of #1723 on the pymodbus device server: a
 * float32 holding 1.5, laid out in each of the four 32 bit orders, reads back as 1.5 only under its
 * own order and as 2.2869e-41, -2.984375 or 6.8965e-41 under the others, with no exception raised. A
 * wrong order is not an error, it is a plausible wrong number. No clause of MB, TCP, SEC or SL
 * orders the registers of a value wider than one register: the only data units the text defines are
 * "Single bit" and "16-bit word" (MB 4.3). So the order is the device's, it comes from the map, and
 * this module refuses to guess it.
 *
 * WHY 64 BIT INTEGERS ARE `bigint`. MEASURED by the issue author: the uint64 at `0102 0304 0506
 * 0708` is 72623859790382856, which is past `Number.MAX_SAFE_INTEGER` (9007199254740991). A number
 * there would be silently wrong, so these decode as `bigint` and are shown as text.
 */

export type WordOrder = "high_first" | "low_first";
export type ByteOrder = "high_first" | "low_first";

export class ModbusDecodeError extends Error {}

export interface Layout {
  readonly wordOrder: WordOrder;
  readonly byteOrder: ByteOrder;
}

export const REGISTERS_OF_TYPE: Readonly<Record<string, number>> = Object.freeze({
  uint16: 1,
  int16: 1,
  uint32: 2,
  int32: 2,
  float32: 2,
  uint64: 4,
  int64: 4,
  float64: 4,
});

/** Lays the words out as the device wrote them, so every decoder below reads one flat buffer. */
export function orderedBytes(words: readonly number[], layout: Layout): Buffer {
  const ordered = layout.wordOrder === "high_first" ? words : [...words].reverse();
  const out = Buffer.alloc(ordered.length * 2);
  ordered.forEach((word, index) => {
    if (!Number.isInteger(word) || word < 0 || word > 0xffff)
      throw new ModbusDecodeError(`A register must be a 16 bit unsigned word, and ${word} is not.`);
    if (layout.byteOrder === "high_first") out.writeUInt16BE(word, index * 2);
    else out.writeUInt16LE(word, index * 2);
  });
  return out;
}

export function decodeScalar(
  type: keyof typeof REGISTERS_OF_TYPE,
  words: readonly number[],
  layout: Layout,
): number | bigint {
  const need = REGISTERS_OF_TYPE[type];
  if (need === undefined) throw new ModbusDecodeError(`Unknown type "${type}".`);
  if (words.length !== need)
    throw new ModbusDecodeError(`Type ${type} needs ${need} register(s) and ${words.length} were given.`);
  const b = orderedBytes(words, layout);
  switch (type) {
    case "uint16":
      return b.readUInt16BE(0);
    case "int16":
      return b.readInt16BE(0);
    case "uint32":
      return b.readUInt32BE(0);
    case "int32":
      return b.readInt32BE(0);
    case "float32":
      return b.readFloatBE(0);
    case "uint64":
      return b.readBigUInt64BE(0);
    case "int64":
      return b.readBigInt64BE(0);
    case "float64":
      return b.readDoubleBE(0);
    default:
      throw new ModbusDecodeError(`Unknown type "${type}".`);
  }
}

/** Applies scale and offset, and never to a `bigint`: that would lose the exactness it is there for. */
export function applyScale(value: number | bigint, scale?: number, offset?: number): number | bigint {
  if (typeof value === "bigint") {
    if (scale !== undefined || offset !== undefined)
      throw new ModbusDecodeError(
        "A 64 bit integer is decoded exactly, so a scale or an offset cannot be applied to it without losing that exactness.",
      );
    return value;
  }
  return value * (scale ?? 1) + (offset ?? 0);
}

/** Unpacks the bit packing of MB 6.1 and 6.2: first byte, lowest address, least significant bit. */
export function decodeBits(bytes: Buffer, quantity: number): boolean[] {
  const needed = Math.ceil(quantity / 8);
  if (bytes.length < needed)
    throw new ModbusDecodeError(`Quantity ${quantity} needs ${needed} byte(s) and ${bytes.length} were given.`);
  const out: boolean[] = [];
  for (let i = 0; i < quantity; i += 1) out.push((((bytes[i >> 3] ?? 0) >> (i % 8)) & 1) === 1);
  return out;
}
