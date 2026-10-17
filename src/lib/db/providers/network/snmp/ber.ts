import { QueryError } from "@/lib/db/errors";
/**
 * The smallest BER reader the valve needs, and nothing more.
 *
 * WHY THIS EXISTS RATHER THAN A SCAN. The first version of the valve looked for the PDU tag
 * bytes (0xa0, 0xa1, 0xa3, 0xa5) anywhere in the outgoing datagram. Measured against
 * `net-snmp` 3.29.2 on 13 October 2026, that found a "PDU type" in every authPriv request,
 * because those byte values occur inside the authentication digest and the ciphertext: the
 * same request reported SetRequest at offsets 41 and 72 under Node 24.14.0 and GetBulkRequest
 * at 68 under Bun 1.4.2. A scan therefore reports a type where none is readable, and can
 * report that it inspected a request whose real type it never saw. The valve parses instead.
 *
 * It reads definite-length tag-length-value only. SNMP messages are definite length
 * (RFC 3417 section 2 maps them onto BER), so an indefinite length is not a form we have to
 * support; it is a form we refuse.
 */

/** One tag-length-value field, with the slice its value occupies. */
export interface BerField {
  readonly tag: number;
  readonly start: number;
  readonly end: number;
}

/**
 * A refusal this provider raises, and the reason it extends `QueryError` rather than `Error`.
 *
 * Measured on 13 October 2026 against `origin/main`: a count that fails is turned into
 * `{ unavailable: error.message }` only for `QueryError` and `TimeoutError`
 * (`providers/platform/kubernetes/objects.ts:348`), and `isQueryError` in `src/lib/db/errors.ts` is
 * the same test. A refusal thrown as a plain `Error` therefore passes as an unexpected failure and
 * ITS SENTENCE NEVER REACHES THE USER. Every refusal in this provider exists for its sentence,
 * so a plain `Error` would have thrown away the whole point of refusing. The first version of
 * this file did exactly that; this is the correction, not a precaution.
 *
 * The prototype is restored because `QueryError`'s own constructor ends with
 * `Object.setPrototypeOf(this, QueryError.prototype)`, which rewrites the prototype of whatever
 * is being constructed. Without the line below, `instanceof` on this class is false and the
 * catch that wanted to tell this refusal apart quietly matches something else.
 *
 * The provider argument is left out on purpose: it takes a `DatabaseType`, and this provider's
 * type-id is not a member of that union until the registration change lands.
 */
export class BerError extends QueryError {
  constructor(message: string) {
    super(message);
    this.name = "BerError";
    Object.setPrototypeOf(this, BerError.prototype);
  }
}

/**
 * Reads the length octets at `offset`, returning the length and the offset of the first
 * content byte. Refuses the indefinite form (0x80) and any length that does not fit the
 * buffer, so a truncated or hostile message fails here rather than further in.
 */
function readLength(buf: Uint8Array, offset: number): { length: number; contentAt: number } {
  if (offset >= buf.length) throw new BerError("length octet past end of message");
  const first = buf[offset];
  if (first < 0x80) return { length: first, contentAt: offset + 1 };
  if (first === 0x80) throw new BerError("indefinite length is not a form SNMP uses");
  const count = first & 0x7f;
  if (count > 4) throw new BerError(`length of ${count} octets is longer than any SNMP message`);
  if (offset + 1 + count > buf.length) throw new BerError("length octets past end of message");
  let length = 0;
  for (let i = 0; i < count; i += 1) length = length * 256 + buf[offset + 1 + i];
  return { length, contentAt: offset + 1 + count };
}

/** One field at `offset`, with its value slice bounded by the buffer. */
export function readField(buf: Uint8Array, offset: number): BerField {
  if (offset >= buf.length) throw new BerError("field past end of message");
  const tag = buf[offset];
  const { length, contentAt } = readLength(buf, offset + 1);
  const end = contentAt + length;
  if (end > buf.length) throw new BerError("field value past end of message");
  return { tag, start: contentAt, end };
}

/** Every field directly inside the value of `parent`, left to right. */
export function readChildren(buf: Uint8Array, parent: BerField, limit = 8): BerField[] {
  const out: BerField[] = [];
  let at = parent.start;
  while (at < parent.end) {
    if (out.length >= limit) throw new BerError(`more than ${limit} fields in one SEQUENCE`);
    const field = readField(buf, at);
    if (field.end > parent.end) throw new BerError("field runs past its parent");
    out.push(field);
    at = field.end;
  }
  return out;
}

/*
 * ----------------------------------------------------------------------------------------
 * Writing.
 *
 * The reader above exists to inspect what the client produced. This half exists because there
 * is no client: the provider builds its own messages, so that nothing in this repository has to
 * carry a dependency whose write paths would then need keeping away from. The house doctrine is
 * explicit about the trade (`docs/ADDING_A_PROVIDER.md:21`), and the precedent is S3's SigV4,
 * which is Studio's own `node:crypto` code rather than an SDK.
 *
 * Encoding is the narrower half of BER and this is the narrowest part of it: definite lengths,
 * the handful of tags SNMP uses, and nothing else. Every value is written minimally, because a
 * non-minimal encoding is legal BER and an agent is entitled to reject it.
 * ----------------------------------------------------------------------------------------
 */

export const TAG_INTEGER = 0x02;
export const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;

/** Length octets, in the short form below 128 and the long form above it. */
/**
 * Exported for its own tests, not for callers.
 *
 * Both refusals below are unreachable through this file: every call site passes a buffer's
 * `length`, which is never negative and never four gigabytes. Measured: removing either one left
 * the whole suite green, because nothing could reach them. They are kept rather than deleted
 * because they state what a length IS, and a reader who later computes one instead of measuring
 * it should meet the rule rather than produce a datagram no agent will parse. Reaching them from
 * a test is what turns that intention into something a mutation can bind.
 */
export function writeLength(length: number): Uint8Array {
  if (length < 0) throw new BerError("a length cannot be negative");
  if (length < 0x80) return Uint8Array.of(length);
  const octets: number[] = [];
  let rest = length;
  while (rest > 0) {
    octets.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  if (octets.length > 4) throw new BerError("a length longer than four octets is longer than any SNMP message");
  return Uint8Array.from([0x80 | octets.length, ...octets]);
}

/** One tag-length-value field. */
function writeField(tag: number, content: Uint8Array): Uint8Array {
  const length = writeLength(content.length);
  const out = new Uint8Array(1 + length.length + content.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(content, 1 + length.length);
  return out;
}

/**
 * A signed integer, minimally.
 *
 * Minimal matters: a leading 0x00 is required when the top bit of the first octet would
 * otherwise make a positive value read as negative, and forbidden when it would not. Writing a
 * fixed four octets would be legal for the value and wrong for the encoding.
 */
export function writeInteger(value: number): Uint8Array {
  if (!Number.isSafeInteger(value)) throw new BerError(`${value} is not an integer this encoder writes`);
  const octets: number[] = [];
  let rest = value;
  do {
    octets.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
    if (value < 0 && rest === -1 && (octets[0] & 0x80) !== 0) rest = 0;
  } while (rest !== 0 && rest !== -1);
  if (value >= 0 && (octets[0] & 0x80) !== 0) octets.unshift(0x00);
  if (value < 0 && (octets[0] & 0x80) === 0) octets.unshift(0xff);
  return writeField(TAG_INTEGER, Uint8Array.from(octets));
}

export function writeOctetString(bytes: Uint8Array): Uint8Array {
  return writeField(TAG_OCTET_STRING, bytes);
}

export function writeNull(): Uint8Array {
  return writeField(TAG_NULL, new Uint8Array(0));
}

/**
 * An object identifier.
 *
 * The first two sub-identifiers share one octet as 40*a+b, which is why an OID shorter than two
 * arcs cannot be written at all, and every sub-identifier after them is base 128 with the
 * continuation bit set on all but the last octet.
 */
export function writeOid(oid: readonly number[]): Uint8Array {
  if (oid.length < 2) throw new BerError("an object identifier needs at least two sub-identifiers to be encoded");
  if (oid[0] > 2 || oid[1] > 39)
    throw new BerError(`${oid[0]}.${oid[1]} is not a legal start for an object identifier`);
  const out: number[] = [oid[0] * 40 + oid[1]];
  for (const sub of oid.slice(2)) {
    if (!Number.isInteger(sub) || sub < 0 || sub > 4294967295) {
      throw new BerError(`${sub} is not a sub-identifier (RFC 2578 section 3.5)`);
    }
    const base128: number[] = [];
    let rest = sub;
    do {
      base128.unshift(rest & 0x7f);
      rest = Math.floor(rest / 128);
    } while (rest > 0);
    for (let i = 0; i < base128.length - 1; i += 1) base128[i] |= 0x80;
    out.push(...base128);
  }
  return writeField(TAG_OID, Uint8Array.from(out));
}

/** Several fields inside one SEQUENCE, or inside any constructed tag. */
export function writeSequence(parts: readonly Uint8Array[], tag: number = TAG_SEQUENCE): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const content = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    content.set(part, at);
    at += part.length;
  }
  return writeField(tag, content);
}
