/**
 * The key a recorded SNMP exchange is found by, and the two ends that use it.
 *
 * WHY A KEY AND NOT THE WHOLE DATAGRAM. Every request carries a request id that changes on every
 * run, so a recording matched byte for byte would never match twice. The key is therefore what the
 * request ASKS - the PDU type, the objects, and a GetBulk's max-repetitions - and the recorded
 * answer is replayed with the live request's id written into it. That is not imitating an
 * envelope: it is putting the recorded BODY in the right envelope, and the body is what the agent
 * decided.
 *
 * Max-repetitions is part of the key on purpose. It is the field that was being dropped on the way
 * to the wire until 14 October 2026, and a key that ignored it would match a broken request to a
 * healthy answer, which is the one thing these recordings must never do.
 */
import {
  type BerField,
  readChildren,
  readField,
  TAG_INTEGER,
  writeLength,
  writeSequence,
} from "@/lib/db/providers/network/snmp/ber";

export interface CapturedExchange {
  /** The key below, as text. */
  readonly key: string;
  /** The agent's datagram, base64, exactly as it arrived. */
  readonly answer: string;
  /** What the request asked, in words, so a reader of the file can see it without decoding. */
  readonly asked: string;
}

/** Where the request id sits inside a PDU, so a replay can write the live one into the answer. */
export interface RequestIdField {
  readonly start: number;
  readonly end: number;
}

/** The PDU tag, the asked OIDs and the PDU's third integer, read from a request datagram. */
export function readRequest(datagram: Uint8Array): {
  readonly pduTag: number;
  readonly oids: readonly string[];
  readonly thirdInteger: number;
  readonly requestId: RequestIdField;
} {
  const [, , pduField] = readChildren(datagram, readField(datagram, 0));
  const pdu = readChildren(datagram, pduField);
  const varbinds = readChildren(datagram, pdu[3]).map((entry) => readChildren(datagram, entry)[0]);
  return {
    pduTag: datagram[pduField.start - headerLength(datagram, pduField)],
    oids: varbinds.map((field) => decodeOid(datagram.slice(field.start, field.end))),
    thirdInteger: intOf(datagram, pdu[2]),
    requestId: { start: pdu[0].start, end: pdu[0].end },
  };
}

/** The key a request is recorded and found under. */
export function keyOf(request: ReturnType<typeof readRequest>): string {
  return `pdu=${request.pduTag} max=${request.thirdInteger} oids=${request.oids.join(",")}`;
}

/**
 * The same answer with the live request's id written over the recorded one.
 *
 * REBUILT RATHER THAN OVERWRITTEN IN PLACE, and the reason is measured. An id is an ASN.1
 * INTEGER, so its width follows its value: `randomInt(1, 0x7fffffff)` encodes in four octets
 * 99.61% of the time and in three 0.39% of the time, while all eight recordings carry four. The
 * first version of this function wrote the id over the recorded one only when the widths matched
 * and otherwise returned the recording UNCHANGED - which answers a live request with a stranger's
 * id. The provider drops that answer, correctly, and then waits its whole deadline for one that
 * never comes.
 *
 * MEASURED: with the generator narrowed to two octets, this file's first two cases time out at
 * the runner's 5000 ms budget, which is exactly the shape CI reported on 16 October 2026. At the
 * real width the odds are about four in a thousand per request, so the suite drew it once in
 * however many runs this branch has had.
 *
 * So the fields are re-encoded through the provider's own writers: the id becomes a fresh INTEGER
 * of whatever width it needs, and the two enclosing lengths are computed rather than patched. The
 * recorded BODY - the varbinds the agent decided - is copied as it stands.
 */
export function withRequestId(answer: Uint8Array, idBytes: Uint8Array): Uint8Array {
  const [version, community, pduField] = readChildren(answer, readField(answer, 0));
  const pdu = readChildren(answer, pduField);
  // Each field re-encoded from its own tag, length and content. NOT from a header width computed
  // backwards from the byte before the content: that byte is the LAST length octet, and in the
  // long form - which the sixteen-varbind answers use - its value is part of the length rather
  // than the header's size. Reading it as a header width is what made the walk cases fail while
  // the single-value ones passed, measured on 16 October 2026.
  const tlv = (field: BerField): Uint8Array =>
    Uint8Array.from([field.tag, ...writeLength(field.end - field.start), ...answer.slice(field.start, field.end)]);
  const id = Uint8Array.from([TAG_INTEGER, ...writeLength(idBytes.length), ...idBytes]);
  return writeSequence([
    tlv(version),
    tlv(community),
    writeSequence([id, tlv(pdu[1]), tlv(pdu[2]), tlv(pdu[3])], pduField.tag),
  ]);
}

function headerLength(buf: Uint8Array, field: { readonly start: number }): number {
  // The tag sits before the length octets, which are one byte under 0x80 and 1 + n above it.
  const lengthByte = buf[field.start - 1];
  return lengthByte < 0x80 ? 2 : 2 + (lengthByte - 0x80);
}

function intOf(buf: Uint8Array, field: { readonly start: number; readonly end: number }): number {
  let value = 0;
  for (const octet of buf.slice(field.start, field.end)) value = value * 256 + octet;
  return value;
}

export function decodeOid(bytes: Uint8Array): string {
  const out = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const octet of bytes.slice(1)) {
    value = value * 128 + (octet & 0x7f);
    if ((octet & 0x80) === 0) {
      out.push(value);
      value = 0;
    }
  }
  return out.join(".");
}
